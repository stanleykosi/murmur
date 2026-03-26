import type { SVGAttributes } from "react";

interface SingularityLoaderProps
  extends Omit<SVGAttributes<SVGSVGElement>, "children"> {}

function joinClassNames(
  ...classNames: Array<string | false | null | undefined>
): string {
  return classNames.filter(Boolean).join(" ");
}

/**
 * Fluid loader used in place of a conventional spinner.
 */
export default function SingularityLoader({
  className,
  ...rest
}: Readonly<SingularityLoaderProps>) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={joinClassNames("ui-singularity-loader", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        className="ui-singularity-loader__shape"
        d="M32 8C43.046 8 52 16.954 52 28C52 39.046 43.046 48 32 48C20.954 48 12 39.046 12 28C12 16.954 20.954 8 32 8Z"
        fill="currentColor"
      >
        <animate
          attributeName="d"
          dur="2.3s"
          repeatCount="indefinite"
          values="
            M32 8C43.046 8 52 16.954 52 28C52 39.046 43.046 48 32 48C20.954 48 12 39.046 12 28C12 16.954 20.954 8 32 8Z;
            M32 9C43.8 5.4 57 17.1 51.4 30.2C56.4 43.8 43.2 57.8 30.8 52.6C17.1 58.6 6.7 45.1 12.8 31C7 17.2 18.1 4.3 32 9Z;
            M32 8C43.046 8 52 16.954 52 28C52 39.046 43.046 48 32 48C20.954 48 12 39.046 12 28C12 16.954 20.954 8 32 8Z
          "
        />
      </path>
      <circle
        cx="32"
        cy="28"
        r="17"
        className="ui-singularity-loader__halo"
      />
    </svg>
  );
}
