/**
 * `pnpm vapid:keys`: prints a fresh VAPID key pair for Web Push, ready to
 * paste into the environment (`.env`, or the deployment's secret). Keep the
 * private key secret; changing the pair makes every device subscribe again.
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:support@yonder.sh");
