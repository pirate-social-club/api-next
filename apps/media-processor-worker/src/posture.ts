/** Provider effects stay disabled unless the binding is exactly `true`. */
export const isMediaProcessingEnabled = (value: string | undefined): boolean => value === "true";
