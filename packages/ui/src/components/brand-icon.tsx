// CAREEROS: alt text comes from the brand, not a hard-coded upstream name. With an organization logo (P2-T02) the
// image is the one the server injected as `window.__BRAND__.logoUrl`; otherwise the platform mark in light and dark.
import { getBrand } from "@reactive-resume/utils/brand";
import { cn } from "@reactive-resume/utils/style";

type Props = React.ComponentProps<"img"> & {
	variant?: "logo" | "icon";
};

export function BrandIcon({ variant = "logo", className, alt = getBrand().appName, ...props }: Props) {
	const { logoUrl } = getBrand();

	// One image serves both themes: an organization uploads a single logo.
	if (logoUrl) {
		return <img src={logoUrl} alt={alt} className={cn("block size-12 object-contain", className)} {...props} />;
	}

	return (
		<>
			<img src={`/${variant}/dark.svg`} alt={alt} className={cn("hidden size-12 dark:block", className)} {...props} />
			<img src={`/${variant}/light.svg`} alt={alt} className={cn("block size-12 dark:hidden", className)} {...props} />
		</>
	);
}
