import type { HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "playing-card": HTMLAttributes<HTMLElement> & {
        cid?: string;
        rank?: string;
        suit?: string;
        opacity?: string;
        backcolor?: string;
        backtext?: string;
        backtextcolor?: string;
        bordercolor?: string;
        borderradius?: string;
        borderline?: string;
      };
    }
  }
}

export {};
