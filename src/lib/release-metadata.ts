// The implementation lives in release-metadata.mjs so the BullMQ worker can share it;
// this module keeps the TypeScript import path stable for the web process.
export { auroraReleaseMetadata } from "./release-metadata.mjs";
export type { AuroraReleaseMetadata } from "./release-metadata.mjs";
