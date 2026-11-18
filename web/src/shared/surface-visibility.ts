import { createContext, useContext } from 'react';

// Portals retain React ownership but escape the workspace's CSS display boundary.
// Keep transient UI tied to its owning surface even when rendered under body.
export const SurfaceActiveContext = createContext(true);
export const useSurfaceActive = () => useContext(SurfaceActiveContext);
