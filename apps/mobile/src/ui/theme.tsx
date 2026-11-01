import type { ColorScheme } from "./tokens";
import Storage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { Appearance, Platform, useColorScheme } from "react-native";
// CAREEROS (P2-T02): the organization's primary colour replaces the accent tokens
import { accentTokens, isHexColor } from "@reactive-resume/utils/brand";
import { colors, fonts, motion, radius, shadows, size, space, type } from "./tokens";
import { useBrand } from "@/branding/store";

/** Settings → Preferences → Appearance. System is the default. */
export type ThemePreference = "system" | "light" | "dark";

const storageKey = "theme";
const listeners = new Set<() => void>();

const readPreference = (): ThemePreference => {
	const stored = Storage.getItemSync(storageKey);
	return stored === "light" || stored === "dark" ? stored : "system";
};

let preference = readPreference();

// The override goes through Appearance, so native UI (alerts, keyboards, pickers) follows it too and
// `useColorScheme` already reports the effective scheme.
const applyPreference = (value: ThemePreference) => {
	if (Platform.OS !== "web") Appearance.setColorScheme(value === "system" ? "unspecified" : value);
};

/** Call once at startup, before the first render. */
export function initTheme() {
	applyPreference(preference);
}

export function setThemePreference(value: ThemePreference) {
	preference = value;
	if (value === "system") Storage.removeItemSync(storageKey);
	else Storage.setItemSync(storageKey, value);
	applyPreference(value);
	for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(subscribe, () => preference);
}

const themes = {
	light: { scheme: "light", colors: colors.light, shadows: shadows.light, fonts, type, space, size, radius, motion },
	dark: { scheme: "dark", colors: colors.dark, shadows: shadows.dark, fonts, type, space, size, radius, motion },
} as const satisfies Record<ColorScheme, { scheme: ColorScheme } & Record<string, unknown>>;

export type Theme = (typeof themes)[ColorScheme];

// CAREEROS (P2-T02): themes with an organization's accent, one per scheme and colour, so the object stays the same
// between renders.
const brandedThemes = new Map<string, Theme>();

function withPrimary(scheme: ColorScheme, primary: string): Theme {
	const key = `${scheme}:${primary}`;
	let branded = brandedThemes.get(key);
	if (!branded) {
		const theme = themes[scheme];
		branded = { ...theme, colors: { ...theme.colors, ...accentTokens(primary)[scheme] } };
		brandedThemes.set(key, branded);
	}
	return branded;
}

/** The token set for the effective colour scheme, with the organization's accent when it has one. */
export function useTheme(): Theme {
	const preference = useThemePreference();
	const system = useColorScheme();
	const { primaryColor } = useBrand();
	const scheme = (preference === "system" ? system : preference) === "dark" ? "dark" : "light";
	return isHexColor(primaryColor) ? withPrimary(scheme, primaryColor) : themes[scheme];
}
