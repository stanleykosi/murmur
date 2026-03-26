/**
 * Frontend-wide ambient type augmentations for the Murmur web app.
 *
 * This file narrows Clerk session claims to Murmur's canonical user-role
 * contract so server components and route guards can read role metadata
 * without unsafe casts or compatibility fallbacks.
 */

import type { UserRole } from "@murmur/shared";

declare global {
  interface CustomJwtSessionClaims {
    metadata?: {
      role?: UserRole;
    };
  }
}

export {};
