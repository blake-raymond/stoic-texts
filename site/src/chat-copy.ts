// Buyer-facing chat sentences. No em dashes. The page shows these strings as the server sends them.

import { MONTHLY_REPLY_CAP } from "./config.ts";

export const FREE_LIMIT_MESSAGE =
  "That was your free conversation. Eight replies. Keep talking with Old Counsel.";

export const MONTHLY_CAP_MESSAGE =
  `You've had ${MONTHLY_REPLY_CAP} replies this month. They start again on the 1st. Email help@oldcounsel.com if that seems wrong.`;

export const INACTIVE_MESSAGE =
  "Your plan isn't active. You can start it again when you're ready.";

export const RATE_LIMIT_MESSAGE = "Too many messages, too quickly. Wait a little, then try again.";

export const SPEND_GUARD_MESSAGE =
  "Old Counsel is pausing new replies right now. Please try again later, or email help@oldcounsel.com.";

export const UNAVAILABLE_MESSAGE = "Old Counsel can't reply right now. Email help@oldcounsel.com.";

export const UPSTREAM_MESSAGE = "Something went wrong before a reply came back. Try again in a moment.";

export const BAD_REQUEST_MESSAGE = "That message couldn't be read. Try a shorter one.";

export const RESTORE_HELP =
  "Email help@oldcounsel.com from the address you paid with.";

export const RESTORE_NEUTRAL =
  "If that email has Old Counsel, a code is on its way. It expires in 15 minutes.";

export const RESTORE_BAD_CODE = "That code did not work.";

export const RESTORE_DONE = "You're in. You can talk now.";

export const RESTORE_WAIT = "Wait a little, then try again.";

export const RESTORE_SUBJECT = "Your Old Counsel code";

export function restoreCodeText(code: string): string {
  return [
    `Your Old Counsel code is ${code}.`,
    "",
    "It expires in 15 minutes. If you did not ask for this, you can ignore this email.",
    "",
    "Old Counsel",
  ].join("\n");
}
