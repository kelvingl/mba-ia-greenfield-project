/** Client for server-to-server calls (Compose service-name endpoint). */
export const INTERNAL_S3_CLIENT = Symbol('INTERNAL_S3_CLIENT');

/**
 * Client used only to sign URLs consumed by the browser. SigV4 signs the host,
 * so it must be built against the host-reachable endpoint (S3_PUBLIC_ENDPOINT).
 */
export const PUBLIC_S3_CLIENT = Symbol('PUBLIC_S3_CLIENT');
