// CAREEROS: React hook over `getBrand()`. The brand is fixed for the life of the page (the server injects it before boot).
import { useMemo } from "react";
import { getBrand } from "@reactive-resume/utils/brand";

export function useBrand() {
	return useMemo(() => getBrand(), []);
}
