export const port = Number(process.env.PORT ?? 8787);

const configuredOrigin = process.env.PUBLIC_ORIGIN;
if (process.env.NODE_ENV === 'production' && !configuredOrigin) {
  throw new Error('PUBLIC_ORIGIN is required in production');
}
const origin = new URL(configuredOrigin ?? 'http://localhost:5173');
if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
  throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
}
export const publicOrigin = origin.origin;
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}
let firebaseWebConfig: FirebaseWebConfig | null = null;
if (process.env.FIREBASE_WEB_CONFIG) {
  try {
    const value: unknown = JSON.parse(process.env.FIREBASE_WEB_CONFIG);
    if (value && typeof value === 'object' && ['apiKey', 'authDomain', 'projectId', 'appId'].every((key) =>
      typeof (value as Record<string, unknown>)[key] === 'string' && (value as Record<string, string>)[key].length > 0)) {
      const config = value as Record<string, string>;
      firebaseWebConfig = { apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId };
    }
  } catch { /* Invalid optional development config remains unavailable. */ }
}
if (process.env.NODE_ENV === 'production' && !process.env.INVITATION_ENCRYPTION_KEY) {
  throw new Error('INVITATION_ENCRYPTION_KEY is required in production');
}
if (process.env.NODE_ENV === 'production' && !process.env.FIREBASE_WEB_CONFIG) {
  throw new Error('FIREBASE_WEB_CONFIG is required in production');
}
if (process.env.NODE_ENV === 'production' && !firebaseWebConfig) {
  throw new Error('FIREBASE_WEB_CONFIG must contain apiKey, authDomain, projectId, and appId');
}
if (process.env.NODE_ENV === 'production' && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required in production');
}
if (process.env.NODE_ENV === 'production') {
  try {
    const credentials: unknown = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
      ['project_id', 'client_email', 'private_key'].some((key) => typeof (credentials as Record<string, unknown>)[key] !== 'string' ||
        !(credentials as Record<string, string>)[key].length)) {
      throw new Error();
    }
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account credentials');
  }
}
