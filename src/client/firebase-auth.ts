import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";

export async function googleFirebaseIdToken(config: { apiKey: string; authDomain: string; projectId: string; appId: string }): Promise<string> {
  const app = getApps().length ? getApp() : initializeApp(config);
  const credential = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  return credential.user.getIdToken();
}
