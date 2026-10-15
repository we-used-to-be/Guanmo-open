import React, { useState, useRef, useId, useEffect } from 'react';
import { ContextMenu, ContextMenuItem } from '@/components/common/ContextMenu';
import styles from './select.module.css';

export type SelectOption = {
    key: string;
    label: string;
};

export interface SelectProps {
    options: SelectOption[];
    value: string;
    onChange: (key: string) => void;
    placeholder?: string;
    disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({
    options,
    value,
    onChange,
    placeholder = '请选择',
    disabled = false,
}) => {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();
    const currentLabel = options.find((option) => option.key === value)?.label || placeholder;

    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);

    const handleSelect = (key: string) => {
        onChange(key);
        setOpen(false);
    };

    return (
        <div className={`${styles.wrapper} ${disabled ? styles.disabled : ''}`}>
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                aria-haspopup="listbox"
                aria-expanded={open && !disabled}
                aria-controls={open && !disabled ? menuId : undefined}
                className={`${styles.trigger} w-full ${open ? styles.open : ''}`}
                onClick={() => setOpen((current) => !current)}
            >
                <span className={value ? styles.value : styles.placeholder}>{currentLabel}</span>
                <span className={styles.arrow}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </span>
            </button>
            {open && !disabled && (
                <ContextMenu id={menuId} role="listbox" aria-label={placeholder} anchor={triggerRef.current}
                    minWidth={Math.max(140, triggerRef.current?.offsetWidth ?? 0)} onClose={() => setOpen(false)}>
                    {options.map((option) => (
                        <ContextMenuItem key={option.key} role="option" selected={value === option.key}
                            onClick={() => handleSelect(option.key)}>{option.label}</ContextMenuItem>
                    ))}
                </ContextMenu>
            )}
        </div>
    );
};

Select.displayName = 'Select';
