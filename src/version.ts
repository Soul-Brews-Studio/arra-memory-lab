import packageMetadata from "../package.json";

export const LAB_VERSION = packageMetadata.version;
export const LAB_CALVER_PATTERN = /^\d{2}\.\d{1,2}\.\d{1,2}-alpha\.\d{1,4}$/;

if (!LAB_CALVER_PATTERN.test(LAB_VERSION)) {
  throw new Error(`Invalid Arra Memory Lab CalVer: ${LAB_VERSION}`);
}
