import { cn } from "cn";
import { OTPInput, REGEXP_ONLY_DIGITS, type SlotProps } from "input-otp";
import type { Ref } from "react";

/**
 * The 6-digit code input (DESIGN §10.1): two groups of three 44 px slots,
 * numeric keyboard, `autocomplete="one-time-code"` so phones offer the code
 * from the email/SMS, and pasting "123 456" or "123-456" fills every slot
 * (QA AUTH-11). `onComplete` fires on the 6th digit.
 */
export function OtpField({
	value,
	onChange,
	onComplete,
	disabled,
	invalid,
	inputRef,
	describedBy,
}: {
	value: string;
	onChange: (v: string) => void;
	onComplete: (code: string) => void;
	disabled?: boolean;
	invalid?: boolean;
	inputRef?: Ref<HTMLInputElement>;
	describedBy?: string;
}) {
	return (
		<OTPInput
			ref={inputRef}
			value={value}
			onChange={onChange}
			onComplete={onComplete}
			maxLength={6}
			pattern={REGEXP_ONLY_DIGITS}
			pasteTransformer={(pasted) => pasted.replace(/\D/g, "").slice(0, 6)}
			inputMode="numeric"
			autoComplete="one-time-code"
			autoFocus
			disabled={disabled}
			aria-label="6-digit code"
			aria-invalid={invalid || undefined}
			aria-describedby={describedBy}
			data-testid="otp-input"
			containerClassName="flex items-center gap-3 has-disabled:opacity-60"
			render={({ slots }) => (
				<>
					<SlotGroup slots={slots.slice(0, 3)} invalid={invalid} />
					<span
						aria-hidden="true"
						className="h-0.5 w-3 rounded-full bg-border"
					/>
					<SlotGroup slots={slots.slice(3)} invalid={invalid} />
				</>
			)}
		/>
	);
}

function SlotGroup({
	slots,
	invalid,
}: {
	slots: SlotProps[];
	invalid?: boolean;
}) {
	return (
		<div className="flex">
			{slots.map((slot, i) => (
				<Slot
					// biome-ignore lint/suspicious/noArrayIndexKey: slot positions are fixed
					key={i}
					{...slot}
					invalid={invalid}
				/>
			))}
		</div>
	);
}

function Slot({
	char,
	placeholderChar,
	isActive,
	hasFakeCaret,
	invalid,
}: SlotProps & { invalid?: boolean }) {
	return (
		<div
			className={cn(
				"relative flex size-11 items-center justify-center border-y border-r border-input bg-background font-mono text-lg font-medium tabular-nums shadow-xs transition-[box-shadow,border-color] duration-150",
				"first:rounded-l-md first:border-l last:rounded-r-md",
				isActive && "z-10 border-ring ring-[3px] ring-ring/50",
				invalid && "border-destructive",
				invalid && isActive && "ring-destructive/20",
			)}
		>
			{char ?? (
				<span className="text-muted-foreground/50">{placeholderChar}</span>
			)}
			{hasFakeCaret && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div className="h-5 w-px animate-pulse bg-foreground motion-reduce:animate-none" />
				</div>
			)}
		</div>
	);
}
