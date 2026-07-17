/**
 * Names that live on user devices: localStorage keys and window events. The
 * historic "chapterline" prefix is permanent for anything already stored on
 * devices — renaming it would orphan existing state.
 */
export const ACTIVE_USER_KEY = "chapterline:active-user";
export const UNLOAD_PLAYER_EVENT = "chapterline:unload-player";
export const PROGRESS_CONFLICT_EVENT = "chapterline:progress-conflict";
