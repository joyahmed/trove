// Ambient declarations for imports TypeScript cannot see through: @wterm/svelte exports its
// stylesheet under a bare "./css" subpath with no type, and the terminal pane imports it.
declare module '@wterm/svelte/css';
