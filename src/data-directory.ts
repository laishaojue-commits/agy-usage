export const ALLOWED_DATA_DIRECTORY_NAMES = ['antigravity'] as const;
export type DataDirectoryName = (typeof ALLOWED_DATA_DIRECTORY_NAMES)[number];
