import { forwardRef } from "react";
import { Input } from "@/components/ui/input";
import { formatMoneyInput, parseMoneyInput } from "@/lib/money-input";

type Props = Omit<React.ComponentProps<typeof Input>, "type" | "value"> & { value: string };

/** Keep raw text/caret during editing; format only after leaving the field. */
export const MoneyInput = forwardRef<HTMLInputElement, Props>(
  ({ value, onChange, onBlur, placeholder = "0,00", ...props }, ref) => {
    const invalid = value.trim() !== "" && parseMoneyInput(value) === null;
    return <Input {...props} ref={ref} type="text" inputMode="decimal" maxLength={40}
      placeholder={placeholder} value={value} aria-invalid={invalid || props["aria-invalid"]}
      title={invalid ? "Informe um valor válido, como 1.250,75, com até duas casas decimais." : props.title}
      onChange={onChange}
      onBlur={(event) => {
        const parsed = parseMoneyInput(event.currentTarget.value);
        if (parsed !== null) {
          const formatted = formatMoneyInput(parsed);
          if (formatted !== event.currentTarget.value) {
            event.currentTarget.value = formatted;
            onChange?.(event);
          }
        }
        onBlur?.(event);
      }} />;
  },
);
MoneyInput.displayName = "MoneyInput";