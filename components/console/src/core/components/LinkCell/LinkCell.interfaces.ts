export interface LinkCellProps<T> {
  data: T;
  value: string | undefined;
  link: string;
  isDisabled?: boolean;
  type?: 'backbone' | 'site' | 'link' | 'van' | 'invitation';
  fitContent?: boolean;
}
