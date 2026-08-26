/** Chain and provider effects stay disabled unless the binding is exactly `true`. */
export const isDataRegistrationEnabled = (value: string | undefined): boolean => value === "true";
