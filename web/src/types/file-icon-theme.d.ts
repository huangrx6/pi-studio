declare module 'virtual:studio-file-icons' {
  export const folderNames: ReadonlyMap<string, string>;
  export const folderNamesExpanded: ReadonlyMap<string, string>;
  export const fileNames: ReadonlyMap<string, string>;
  export const fileExtensions: ReadonlyMap<string, string>;
  export const lightIcons: Readonly<Record<string, string | undefined>>;
  export const iconColors: Readonly<Record<string, string | undefined>>;
  export const urls: Readonly<Record<string, string>>;
}
