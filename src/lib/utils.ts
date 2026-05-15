import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isSunday(date: string): boolean {
  return new Date(date + "T12:00:00").getDay() === 0;
}
