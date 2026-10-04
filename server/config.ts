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
