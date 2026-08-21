import { Check, ChevronsUpDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { field } from './field';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * A combobox: a `Select` you can type into — for a list long enough to search
 * (plans, skills, MCP servers, accounts). A Popover anchored to a `field`
 * trigger, with a `Command` inside; cmdk filters, Radix positions and
 * dismisses. The trigger carries `role="combobox"` + `aria-expanded`, so the
 * pattern reads right to assistive tech without a second ARIA layer.
 */
export interface ComboboxOption {
  value: string;
  label: string;
  /** Extra words cmdk may match on (an id, an alias). */
  keywords?: string[];
  hint?: ReactNode;
  disabled?: boolean;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Choose…',
  searchPlaceholder = 'Type to filter…',
  emptyText = 'Nothing matches.',
  label,
  disabled = false,
  clearable = false,
  className,
  id,
}: {
  options: readonly ComboboxOption[];
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /** The accessible name of the trigger (a visible `<Label htmlFor>` may supply it instead). */
  label?: string;
  disabled?: boolean;
  /** Selecting the current value again clears it. */
  clearable?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const triggerId = id ?? `combobox-${reactId}`;
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={triggerId}
          role="combobox"
          aria-expanded={open}
          // aria-controls comes from Radix's PopoverTrigger (the content id):
          // cmdk's List overrides any id handed to it, so naming a list id
          // here pointed assistive tech at an element that never existed.
          aria-haspopup="listbox"
          aria-label={label}
          disabled={disabled}
          className={cn(
            field,
            'inline-flex w-full items-center justify-between gap-2 text-left',
            selected ? 'text-ink' : 'text-ink-faint',
            'hover:border-rule-strong',
            className,
          )}
        >
          <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown size={14} aria-hidden className="shrink-0 text-ink-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  onSelect={(picked) => {
                    const next = clearable && picked === value ? null : picked;
                    onChange(next);
                    setOpen(false);
                  }}
                >
                  <Check
                    size={14}
                    aria-hidden
                    className={cn('shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint != null && (
                    <span className="ml-auto pl-3 text-2xs text-ink-faint">{option.hint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
