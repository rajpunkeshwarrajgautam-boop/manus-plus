/** Single env contract for Expo — set EXPO_PUBLIC_* in .env (see repo env.example). */
export const ORCHESTRATOR_URL = process.env.EXPO_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:4100";
export const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL ?? "ws://localhost:4102";
