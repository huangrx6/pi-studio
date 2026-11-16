declare module 'virtual:studio-file-icons' {
  export const fileNames: ReadonlyMap<string, string>;
  export const fileExtensions: ReadonlyMap<string, string>;
  export const lightIcons: Readonly<Record<string, string | undefined>>;
  export const urls: Readonly<Record<string, string>>;
}
