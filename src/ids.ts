/** UUID v7 ids generated in the app (TZ §8): time-ordered, so id order = creation order. */
import { v7 } from 'uuid';

export const newId = (): string => v7();
