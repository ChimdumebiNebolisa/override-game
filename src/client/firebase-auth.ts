import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, getRedirectResult, GoogleAuthProvider, signInWithRedirect } from 'firebase/auth';

export type GoogleAuthReturnScreen = 'profile' | 'ranked';
const AUTH_RETURN_PARAM = 'overrideAuthReturn';
let redirectResult: Promise<string | null> | null = null;

function firebaseApp(config: { apiKey: string; authDomain: string; projectId: string; appId: string }) {
  return getApps().length ? getApp() : initializeApp(config);
}

export async function beginGoogleFirebaseSignIn(
  config: { apiKey: string; authDomain: string; projectId: string; appId: string },
  returnScreen: GoogleAuthReturnScreen,
): Promise<void> {
  const originalUrl = new URL(window.location.href);
  const returnUrl = new URL(originalUrl);
  returnUrl.searchParams.set(AUTH_RETURN_PARAM, returnScreen);
  window.history.replaceState(null, '', `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`);
  try {
    await signInWithRedirect(getAuth(firebaseApp(config)), new GoogleAuthProvider());
  } catch (error) {
    window.history.replaceState(null, '', `${originalUrl.pathname}${originalUrl.search}${originalUrl.hash}`);
    throw error;
  }
}

export function completeGoogleFirebaseRedirect(
  config: { apiKey: string; authDomain: string; projectId: string; appId: string },
): Promise<string | null> {
  if (!redirectResult) {
    redirectResult = getRedirectResult(getAuth(firebaseApp(config)))
      .then((credential) => credential ? credential.user.getIdToken() : null);
  }
  return redirectResult;
}

export function googleAuthReturnScreenFromLocation(): GoogleAuthReturnScreen | null {
  const value = new URL(window.location.href).searchParams.get(AUTH_RETURN_PARAM);
  return value === 'profile' || value === 'ranked' ? value : null;
}

export function clearGoogleAuthReturnFromLocation(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(AUTH_RETURN_PARAM)) return;
  url.searchParams.delete(AUTH_RETURN_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
