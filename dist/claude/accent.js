import { DEFAULT_ACCENT } from "../shared/tree.js";
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
const BASE_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey'];
// The renderer silently ignores a colour name it does not know, so only names it draws are accepted.
// Keyed by lower-case spelling, valued by the canonical camelCase spelling the renderer expects.
const NAMED = Object.fromEntries([
    ...BASE_NAMES.map(name => [name, name]),
    ...BASE_NAMES.map(name => [`${name}bright`, `${name}Bright`]),
    ['claude', 'claude'],
]);
// The $.store key that keeps the colour set by `/todo color` across sessions.
export const ACCENT_STORE_KEY = 'accentColor';
// Returns the canonical accent for a #rrggbb hex or an allowed colour name (any letter case), else
// null. The parameter is `unknown` because $.store.get and plugin options return untyped JSON.
export const validAccent = (value) => {
    if (typeof value !== 'string')
        return null;
    if (HEX_PATTERN.test(value))
        return value;
    return Object.hasOwn(NAMED, value.toLowerCase()) ? (NAMED[value.toLowerCase()] ?? null) : null;
};
// Saved `/todo color` value > `accentColor` plugin option > DEFAULT_ACCENT. An invalid value at
// either level is skipped. Both params are `unknown`: $.store.get and plugin options are untyped.
export const resolveAccent = (saved, option) => validAccent(saved) ?? validAccent(option) ?? DEFAULT_ACCENT;
