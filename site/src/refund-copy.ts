// Buyer-facing sentences for /refund. No em dashes. The page and the API share these.

export const NEUTRAL =
  "If that email has a purchase, a code is on its way. It expires in 15 minutes.";
export const DONE = "Your refund is on its way. It takes 5 to 10 business days to appear.";
export const ALREADY = "That purchase is already refunded.";
export const BAD_CODE = "That code did not work.";
export const WAIT = "Wait a little, then try again.";
export const FALLBACK = "Email help@oldcounsel.com and you'll be refunded in full.";
export const ENTER_EMAIL = "Enter the email from your purchase.";
export const FAILED = "We could not complete the refund. Email help@oldcounsel.com.";
export const NONE = "We could not find a charge to refund. Email help@oldcounsel.com.";

export const FROM_EMAIL = "noreply@oldcounsel.com";
export const FROM_NAME = "Old Counsel";
export const CODE_SUBJECT = "Your refund code";

export function codeEmailText(code: string): string {
  return [
    `Your refund code is ${code}.`,
    "",
    "It expires in 15 minutes. If you did not ask for this, you can ignore this email.",
    "",
    "Old Counsel",
  ].join("\n");
}
