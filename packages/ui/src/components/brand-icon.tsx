// CAREEROS: alt text comes from the brand, not a hard-coded upstream name.
import { getBrand } from "@reactive-resume/utils/brand";
import { cn } from "@reactive-resume/utils/style";

type Props = React.ComponentProps<"img"> & {
	variant?: "logo" | "icon";
};

export function BrandIcon({ variant = "logo", className, alt = getBrand().appName, ...props }: Props) {
	return (
		<>
			<img src={`/${variant}/dark.svg`} alt={alt} className={cn("hidden size-12 dark:block", className)} {...props} />
			<img src={`/${variant}/light.svg`} alt={alt} className={cn("block size-12 dark:hidden", className)} {...props} />
		</>
	);
}
