import 'solid-js';

declare module 'solid-js' {
  namespace JSX {
    interface DOMAttributes<T> {
      className?: string | undefined;
    }
    interface CustomAttributes<T> {
      className?: string | undefined;
    }
    interface HTMLAttributes<T> {
      className?: string | undefined;
    }
    interface StylableSVGAttributes {
      className?: string | undefined;
    }
    interface SVGAttributes<T> {
      className?: string | undefined;
    }
  }
}

declare global {
  namespace JSX {
    interface HTMLAttributes<T> {
      className?: string | undefined;
    }
    interface SVGAttributes<T> {
      className?: string | undefined;
    }
    interface DOMAttributes<T> {
      className?: string | undefined;
    }
  }
}
