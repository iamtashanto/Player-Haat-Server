/** Prints a fresh VAPID key pair for `.env` (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Run once per environment. */
import webpush from "web-push";

const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);
