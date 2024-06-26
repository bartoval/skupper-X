/*
 Licensed to the Apache Software Foundation (ASF) under one
 or more contributor license agreements.  See the NOTICE file
 distributed with this work for additional information
 regarding copyright ownership.  The ASF licenses this file
 to you under the Apache License, Version 2.0 (the
 "License"); you may not use this file except in compliance
 with the License.  You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing,
 software distributed under the License is distributed on an
 "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 KIND, either express or implied.  See the License for the
 specific language governing permissions and limitations
 under the License.
*/

"use strict";

const formidable = require('formidable');
const db         = require('./db.js');
const sync       = require('./manage-sync.js');
const Log        = require('./common/log.js').Log;
const deployment = require('./site-deployment-state.js');
const util       = require('./common/util.js');

const API_PREFIX = '/api/v1alpha1/';

const createVan = async function(bid, req, res) {
    var returnStatus;
    const form = new formidable.IncomingForm();
    try {
        const [fields, files] = await form.parse(req)
        const norm = util.ValidateAndNormalizeFields(fields, {
            'name'        : {type: 'string',     optional: false},
            'starttime'   : {type: 'timestampz', optional: true, default: null},
            'endtime'     : {type: 'timestampz', optional: true, default: null},
            'deletedelay' : {type: 'interval',   optional: true, default: null},
        });

        const client = await db.ClientFromPool();
        try {
            await client.query("BEGIN");

            var extraCols = "";
            var extraVals = "";

            //
            // Handle the optional fields
            //
            if (norm.starttime) {
                extraCols += ', StartTime';
                extraVals += `, '${norm.starttime}'`;
            }

            if (norm.endtime) {
                extraCols += ', EndTime';
                extraVals += `, '${norm.endtime}'`;
            }

            if (norm.deletedelay) {
                extraCols += ', DeleteDelay';
                extraVals += `, '${norm.deletedelay}'`;
            }

            //
            // Create the application network
            //
            const result = await client.query(`INSERT INTO ApplicationNetworks(Name, Backbone${extraCols}) VALUES ($1, $2${extraVals}) RETURNING Id`, [norm.name, bid]);
            const vanId = result.rows[0].id;
            await client.query("COMMIT");

            returnStatus = 201;
            res.status(returnStatus).json({id: vanId});
        } catch (error) {
            await client.query("ROLLBACK");
            returnStatus = 500
            res.status(returnStatus).send(error.message);
        } finally {
            client.release();
        }
    } catch (error) {
        returnStatus = 400;
        res.status(returnStatus).json({ message: error.message });
    }

    return returnStatus;
}

const createInvitation = async function(vid, req, res) {
    var returnStatus;
    const form = new formidable.IncomingForm();
    try {
        const [fields, files] = await form.parse(req)
        const norm = util.ValidateAndNormalizeFields(fields, {
            'name'            : {type: 'string',     optional: false},
            'claimaccess'     : {type: 'uuid',       optional: false},
            'primaryaccess'   : {type: 'uuid',       optional: false},
            'secondaryaccess' : {type: 'uuid',       optional: true, default: null},
            'joindeadline'    : {type: 'timestampz', optional: true, default: null},
            'siteclass'       : {type: 'string',     optional: true, default: null},
            'instancelimit'   : {type: 'number',     optional: true, default: null},
            'interactive'     : {type: 'bool',       optional: true, default: false},
        });

        const client = await db.ClientFromPool();
        try {
            await client.query("BEGIN");

            var extraCols = "";
            var extraVals = "";

            //
            // Handle the optional fields
            //
            if (norm.siteclass) {
                extraCols += ', MemberClass';
                extraVals += `, '${norm.siteclass}'`;
            }

            if (norm.instancelimit) {
                extraCols += ', InstanceLimit';
                extraVals += `, ${norm.instancelimit}`;
            }

            //
            // Create the application network
            //
            const result = await client.query(`INSERT INTO MemberInvitations(Name, MemberOf, ClaimAccess, InteractiveClaim${extraCols}) ` +
                                              `VALUES ($1, $2, $3, $4${extraVals}) RETURNING Id`, [norm.name, vid, norm.claimaccess, norm.interactive]);
            const invitationId = result.rows[0].id;

            await client.query("INSERT INTO EdgeLinks(AccessPoint, EdgeToken, Priority) VALUES ($1, $2, 1)", [norm.primaryaccess, invitationId]);

            if (norm.secondaryaccess) {
                await client.query("INSERT INTO EdgeLinks(AccessPoint, EdgeToken, Priority) VALUES ($1, $2, 2)", [norm.secondaryaccess, invitationId]);
            }
            await client.query("COMMIT");

            returnStatus = 201;
            res.status(returnStatus).json({id: invitationId});
        } catch (error) {
            await client.query("ROLLBACK");
            returnStatus = 500
            res.status(returnStatus).send(error.message);
        } finally {
            client.release();
        }
    } catch (error) {
        returnStatus = 400;
        res.status(returnStatus).json({ message: error.message });
    }

    return returnStatus;
}

const readVan = async function(res, vid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT ApplicationNetworks.Name, ApplicationNetworks.LifeCycle, ApplicationNetworks.Failure, Backbones.Id as backboneid, Backbones.Name as backbonename, StartTime, EndTime, DeleteDelay FROM ApplicationNetworks " +
                                          "JOIN Backbones ON ApplicationNetworks.Backbone = Backbones.Id WHERE ApplicationNetworks.Id = $1", [vid]);
        if (result.rowCount == 1) {
            res.status(returnStatus).json(result.rows[0]);
        } else {
            returnStatus = 400;
            res.status(returnStatus).end();
        }
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const readInvitation = async function(res, iid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT MemberInvitations.Name, MemberInvitations.LifeCycle, MemberInvitations.Failure, ApplicationNetworks.Name as vanname, JoinDeadline, InstanceLimit, InstanceCount, InteractiveClaim as interactive FROM MemberInvitations " +
                                          "JOIN ApplicationNetworks ON ApplicationNetworks.Id = MemberInvitations.MemberOf WHERE MemberInvitations.Id = $1", [iid]);
        if (result.rowCount == 1) {
            res.status(returnStatus).json(result.rows[0]);
        } else {
            returnStatus = 400;
            res.status(returnStatus).end();
        }
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const readVanMember = async function(res, mid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT MemberSites.Name, MemberSites.LifeCycle, MemberSites.Failure, ApplicationNetworks.Name as vanname, FiratActiveTime, LastHeartbeat, SiteClass FROM MemberSites " +
                                          "JOIN ApplicationNetworks ON ApplicationNetworks.Id = MemberSites.MemberOf WHERE MemberSites.Id = $1", [mid]);
        if (result.rowCount == 1) {
            res.status(returnStatus).json(result.rows[0]);
        } else {
            returnStatus = 400;
            res.status(returnStatus).end();
        }
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const listVans = async function(res, bid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT Id, Name, LifeCycle, Failure, StartTime, EndTime, DeleteDelay FROM ApplicationNetworks WHERE Backbone = $1", [bid]);
        res.status(returnStatus).json(result.rows);
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const listAllVans = async function(res, bid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT ApplicationNetworks.Id, Backbone, Backbones.Name as backbonename, ApplicationNetworks.Name, ApplicationNetworks.LifeCycle, ApplicationNetworks.Failure, StartTime, EndTime, DeleteDelay FROM ApplicationNetworks " +
                                          "JOIN Backbones ON Backbones.Id = Backbone");
        res.status(returnStatus).json(result.rows);
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const listInvitations = async function(res, vid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT Id, Name, LifeCycle, Failure, JoinDeadline, MemberClass, InstanceLimit, InstanceCount, InteractiveClaim as interactive FROM MemberInvitations WHERE MemberOf = $1", [vid]);
        res.status(returnStatus).json(result.rows);
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const listVanMembers = async function(res, vid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT id, Name, LifeCycle, Failure, FirstActiveTime, LastHeartbeat, SiteClass FROM MemberSites WHERE MemberOf = $1", [vid]);
        res.status(returnStatus).json(result.rows);
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const deleteVan = async function(res, vid) {
    var returnStatus = 204;
    const client = await db.ClientFromPool();
    try {
        await client.query("BEGIN");
        const result = await client.query("SELECT Id FROM MemberSites WHERE MemberOf = $1 LIMIT 1", [vid]);
        if (result.rowCount == 0) {
            const delResult = await client.query("DELETE FROM ApplicationNetworks WHERE Id = $1 RETURNING Certificate", [vid]);
            if (delResult.rowCount == 1) {
                if (delResult.certificate) {
                    await client.query("DELETE FROM TlsCertificates WHERE Id = $1", [delResult.certificate]);
                }
                res.status(returnStatus).send("Application network deleted");
            } else {
                returnStatus = 404;
                res.status(returnStatus).send("Application network not found");
            }
        } else {
            returnStatus = 400;
            res.status(returnStatus).send('Cannot delete application network because is still has members');
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        returnStatus = 500;
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const deleteInvitation = async function(res, iid) {
    var returnStatus = 204;
    const client = await db.ClientFromPool();
    try {
        await client.query("BEGIN");
        const result = await client.query("SELECT id FROM MemberSites WHERE Invitation = $1 LIMIT 1", [iid]);
        if (result.rowCount == 0) {
            const invResult = await client.query("DELETE FROM MemberInvitations WHERE Id = $1 RETURNING Certificate", [iid]);
            if (invResult.rowCount == 1) {
                const row = invResult.rows[0];
                if (row.certificate) {
                    await client.query("DELETE FROM TlsCertificates WHERE Id = $1", [row.certificate]);
                }
            }
            res.status(returnStatus).end();
        } else {
            returnStatus = 400;
            res.status(returnStatus).send('Cannot delete invitation because members still exist that use the invitation');
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const expireInvitation = async function(res, iid) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("UPDATE MemberInvitations SET Lifecycle = 'expired', Failure = 'Expired via API' WHERE Id = $1 RETURNING Id", [iid]);
        if (result.rowCount == 0) {
            returnStatus = 404;
        }
        res.status(returnStatus).end();
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const evictMember = async function(mid, req, res) {
}

const evictVan = async function(vid, req, res) {
}

const listClaimAccessPoints = async function(res, bid, ref) {
    var returnStatus = 200;
    const client = await db.ClientFromPool();
    try {
        const result = await client.query("SELECT BackboneAccessPoints.Name as accessname, BackboneAccessPoints.Id as accessid FROM InteriorSites " +
                                          `JOIN BackboneAccessPoints ON BackboneAccessPoints.Id = InteriorSites.${ref} ` +
                                          "WHERE InteriorSites.Backbone = $1", [bid]);
        let data = [];
        for (const row of result.rows) {
            data.push({
                id   : row.accessid,
                name : row.accessname
            });
        }
        res.status(returnStatus).json(data);
    } catch (error) {
        returnStatus = 500
        res.status(returnStatus).send(error.message);
    } finally {
        client.release();
    }
    return returnStatus;
}

const apiLog = function(req, status) {
    Log(`UserAPI: ${req.ip} - (${status}) ${req.method} ${req.originalUrl}`);
}

exports.Initialize = async function(api, keycloak) {
    Log('[API User interface starting]');

    //========================================
    // Application Networks
    //========================================

    // CREATE
    api.post(API_PREFIX + 'backbone/:bid/vans', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await createVan(req.params.bid, req, res));
    });

    // READ
    api.get(API_PREFIX + 'van/:vid', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await readVan(res, req.params.vid));
    });

    // LIST
    api.get(API_PREFIX + 'backbone/:bid/vans', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listVans(res, req.params.bid));
    });

    // LIST ALL
    api.get(API_PREFIX + 'vans', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listAllVans(res));
    });

    // DELETE
    api.delete(API_PREFIX + 'van/:vid', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await deleteVan(res, req.params.vid));
    });

    // COMMANDS
    api.put(API_PREFIX + 'van/:vid/evict', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await evictVan(req.params.vid, req, res));
    });

    //========================================
    // Invitations
    //========================================

    // CREATE
    api.post(API_PREFIX + 'van/:vid/invitations', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await createInvitation(req.params.vid, req, res));
    });

    // READ
    api.get(API_PREFIX + 'invitation/:iid', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await readInvitation(res, req.params.iid));
    });

    // LIST
    api.get(API_PREFIX + 'van/:vid/invitations', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listInvitations(res, req.params.vid));
    });

    // DELETE
    api.delete(API_PREFIX + 'invitation/:iid', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await deleteInvitation(res, req.params.iid));
    });

    // COMMANDS
    api.put(API_PREFIX + 'invitation/:iid/expire', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await expireInvitation(res, req.params.iid));
    })

    //========================================
    // Member Sites
    //========================================

    // READ
    api.get(API_PREFIX + 'member/:mid', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await readVanMember(res, req.params.mid));
    });

    // LIST
    api.get(API_PREFIX + 'van/:vid/members', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listVanMembers(res, req.params.vid));
    });

    // COMMANDS
    api.put(API_PREFIX + 'member/:mid/evict', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await evictMember(req.params.mid, req, res));
    });

    //========================================
    // Queries for filling forms
    //========================================

    // Claim Access Points
    api.get(API_PREFIX + 'backbone/:bid/access/claim', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listClaimAccessPoints(res, req.params.bid, 'ClaimAccess'));
    });

    // Member Access Points
    api.get(API_PREFIX + 'backbone/:bid/access/member', keycloak.protect('realm:van-owner'), async (req, res) => {
        apiLog(req, await listClaimAccessPoints(res, req.params.bid, 'MemberAccess'));
    });
}