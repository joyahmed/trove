// "Retry as administrator" (plan 05 5.6): which failures it is offered on.

/** Whether an operation failed with access denied, as Rust's io::Error words it on Windows
 * (`Access is denied. (os error 5)`): the one failure running it elevated could fix. */
export const isAccessDenied = (err: unknown): boolean => /\(os error 5\)/.test(String(err));

/** The button's words, one place. */
export const RETRY_AS_ADMIN = 'Retry as administrator';
