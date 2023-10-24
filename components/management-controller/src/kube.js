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

const k8s         = require('@kubernetes/client-node');
const fs          = require('fs');
const YAML        = require('yaml');
const db          = require('./db.js');
const config      = require('./config.js');
const Log         = require('./log.js').Log;
const Flush       = require('./log.js').Flush;

var kc;
var client;
var v1Api;
var v1AppApi;
var customApi;
var serviceWatch;
var depWatch;
var namespace = 'default';

const KUBECONFIG = process.env.KUBECONFIG || '~/.kube/config';

exports.Namespace = function() {
    return namespace;
}

exports.Start = function (in_cluster) {
    return new Promise((resolve, reject) => {
        kc = new k8s.KubeConfig();
        if (in_cluster) {
            kc.loadFromCluster();
        } else {
            kc.loadFromDefault();
        }
        client       = k8s.KubernetesObjectApi.makeApiClient(kc);
        v1Api        = kc.makeApiClient(k8s.CoreV1Api);
        v1AppApi     = kc.makeApiClient(k8s.AppsV1Api);
        customApi    = kc.makeApiClient(k8s.CustomObjectsApi);
        serviceWatch = new k8s.Watch(kc);
        depWatch     = new k8s.Watch(kc);

        try {
            if (in_cluster) {
                namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8');
            } else {
                kc.contexts.forEach(context => {
                    if (context.name == kc.currentContext) {
                        namespace = context.namespace;
                    }
                });
            }
            Log(`Running in namespace: ${namespace}`);

        } catch (err) {
            Log(`Unable to determine namespace, using ${namespace}`);
        }
        resolve();
    });
}

exports.GetIssuers = function() {
    return customApi.listNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'issuers'
    )
    .then(list => list.body.items);
}

exports.LoadIssuer = function(name) {
    return customApi.getNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'issuers',
        name
    )
    .then(issuer => issuer.body);
}

exports.CreateIssuer = function() {
    // TODO
}

exports.DeleteIssuer = function(name) {
    return customApi.deleteNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'issuers',
        name
    )
    .catch(err => `Error deleting issuer ${err.stack}`);
}

exports.GetCertificates = function() {
    return customApi.listNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates'
    )
    .then(list => list.body.items);
}

exports.LoadCertificate = function(name) {
    return customApi.getNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates',
        name
    )
    .then(issuer => issuer.body);
}

exports.CreateCertificate = function() {
    // TODO
}

exports.DeleteCertificate = function(name) {
    return customApi.deleteNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates',
        name
    )
    .catch(err => `Error deleting issuer ${err.stack}`);
}

exports.LoadSecret = function(name) {
    return v1Api.readNamespacedSecret(name, namespace)
    .then(secret => secret.body);
}

exports.DeleteSecret = function(name) {
    return v1Api.deleteNamespacedSecret(name, namespace)
    .catch(err => `Error deleting secret ${err.stack}`);
}

exports.GetDeployments = function() {
    return v1AppApi.listNamespacedDeployment(namespace)
    .then(list => list.body.items);
}

exports.LoadDeployment = function(name) {
    return v1AppApi.readNamespacedDeployment(name, namespace)
    .then(dep => dep.body);
}

exports.DeleteDeployment = function(name) {
    return v1AppApi.deleteNamespacedDeployment(name, namespace)
    .catch(err => `Error deleting deployment ${err.stack}`);
}

exports.UpdateSkupperServices = function(serviceData) {
    return v1Api.readNamespacedConfigMap('skupper-services', namespace)
    .then(skupperServices => {
        skupperServices.body.data = serviceData;
        return v1Api.replaceNamespacedConfigMap('skupper-services', namespace, skupperServices.body);
    });
}

exports.GetServices = function() {
    return v1Api.listNamespacedService(namespace)
    .then(services => services.body.items);
}

exports.GetService = function(name) {
    return v1Api.readNamespacedService(name, namespace)
    .then(service => service.body);
}

exports.ReplaceService = function(name, newService) {
    return v1Api.replaceNamespacedService(name, namespace, newService);
}

exports.GetPods = function() {
    return v1Api.listNamespacedPod(namespace)
    .then(pods => pods.body.items);
}


//==========================================================================
// Deployment Watcher
//==========================================================================
var depResourceVersion = '';
var depCallback;

const depTracker = function(path, restart) {
    depWatch.watch(
        path,
        {resourceVersion : depResourceVersion},
        (type, apiObj, watchObj) => {
            depCallback(type, apiObj)
            .then(() => Log(`successful callback on deployment ${type}`))
            .catch(err => Log(`Exception during deployment event: ${err.stack}`));
        },
        (err) => {
            if (err) {
                Log(`Deployment watch done: ${err}`);
                restart();
            }
        })
        .then(req => setTimeout(function() {
            req.abort();
            restart();
        }, config.KubeWatchInterval() * 1000));
}

exports.WatchDeployments = function(callback, restart) {
    return v1AppApi.listNamespacedDeployment(namespace)
    .then(list => new Promise((resolve, reject) => {
        depResourceVersion = list.body.metadata.resourceVersion;
        let existsSet = [];
        list.body.items.forEach(dep => {
            dep.apiVersion = 'apps/v1';
            existsSet.push(dep);
        });
        callback('EXISTS', existsSet);
        resolve(`/apis/apps/v1/namespaces/${namespace}/deployments`);
    }))
    .then(path => {
        depCallback = callback;
        depTracker(path, restart);
    });
}

//==========================================================================
// Service Watcher
//==========================================================================
var serviceResourceVersion = '';
var serviceCallback;

const serviceTracker = function(path, restart) {
    serviceWatch.watch(
        path,
        {resourceVersion : serviceResourceVersion},
        (type, apiObj, watchObj) => {
            serviceCallback(type, apiObj)
            .then(() => Log(`successful callback on service ${type}`))
            .catch(err => Log(`Exception during service event: ${err.stack}`));
        },
        (err) => {
            if (err) {
                Log(`Service watch done: ${err}`);
                restart();
            }
        })
        .then(req => setTimeout(function() {
            req.abort();
            restart();
        }, config.KubeWatchInterval() * 1000));
}

exports.WatchServices = function(callback, restart) {
    return v1Api.listNamespacedService(namespace)
    .then(list => new Promise((resolve, reject) => {
        serviceResourceVersion = list.body.metadata.resourceVersion;
        let existsSet = [];
        list.body.items.forEach(service => existsSet.push(service));
        resolve(existsSet);
    }))
    .then(existsSet => callback('EXISTS', existsSet))
    .then(() => {
        serviceCallback = callback;
        serviceTracker(`/api/v1/namespaces/${namespace}/services`, restart);
    });
}

exports.GetObjects = function(kind) {
    switch (kind) {
        case 'Deployment'     : return v1AppApi.listNamespacedDeployment(namespace).then(list => list.body.items);
        case 'ConfigMap'      : return v1Api.listNamespacedConfigMap(namespace).then(list => list.body.items);
        case 'Secret'         : return v1Api.listNamespacedSecret(namespace).then(list => list.body.items);
        case 'Service'        : return v1Api.listNamespacedService(namespace).then(list => list.body.items);
        case 'ServiceAccount' : return v1Api.listNamespacedServiceAccount(namespace).then(list => list.body.items);
    }
    return new Promise((resolve, reject) => resolve([]));
}

exports.ApplyYaml = function(yaml, parentId) {
    let obj = YAML.parse(yaml);
    if (obj.metadata.annotations == undefined) {
        obj.metadata.annotations = {};
    }
    obj.metadata.annotations["skupper.io/skx-controlled"] = "true";
    obj.metadata.annotations["skupper.io/skx-parent"]     = parentId;
    obj.metadata.namespace = namespace;
    Log(`Creating resource: ${obj.kind} ${obj.metadata.name}`);
    Log(obj);
    return client.create(obj);
}

exports.DeleteObject = function(kind, name) {
    let api = 'v1';
    switch (kind) {
        case 'Deployment' :
        case 'DaemonSet'  :
        case 'ReplicaSet' :
            api = 'apps/v1';
            break;
        case 'StorageClass':
        case 'VolumeAttachement':
            api = 'storage.k8s.io';
            break;
    }
    Log(`Deleting resource: ${kind} ${name}`);
    return client.delete({
        apiVersion : api,
        kind       : kind,
        metadata   : {
            namespace : namespace,
            name      : name,
        },
    })
}