import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = React.ComponentProps<"input"> & {
  onValueChange?: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, onChange, onInput, onValueChange, ...props },
  ref
) {
  const lastInputEventRef = React.useRef<Event | null>(null)

  const emitValueChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange?.(event.currentTarget.value, event)
      onChange?.(event)
    },
    [onChange, onValueChange]
  )

  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-2 text-base leading-5 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      onInput={(event) => {
        lastInputEventRef.current = event.nativeEvent
        emitValueChange(event as unknown as React.ChangeEvent<HTMLInputElement>)
        onInput?.(event)
      }}
      onChange={(event) => {
        if (lastInputEventRef.current !== event.nativeEvent) {
          emitValueChange(event)
        }
      }}
      {...props}
    />
  )
})

export { Input }
