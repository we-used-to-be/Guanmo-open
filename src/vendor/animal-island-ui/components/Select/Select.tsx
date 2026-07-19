import React, { useState, useRef, useEffect } from 'react';
import styles from './select.module.css';
import selectCursor from '../../assets/img/cursor/select-cursor.svg?inline';

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
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const [mounted, setMounted] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const currentLabel = options.find((o) => o.key === value)?.label || placeholder;

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
                setOpen(false);
                setMounted(false);
            }
        };
        if (open) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

    useEffect(() => {
        if (open && wrapperRef.current) {
            const rect = wrapperRef.current.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const dropdownHeight = options.length * 44 + 24;

            const newStyle: React.CSSProperties = {
                position: 'absolute',
                width: rect.width,
                left: 0,
                right: 'auto',
                maxHeight: 260,
                overflowY: 'auto',
            };

            // 垂直方向：默认向下弹出，空间不足时向上
            const spaceBelow = viewportHeight - rect.bottom;
            const spaceAbove = rect.top;

            if (spaceBelow >= dropdownHeight) {
                newStyle.top = '100%';
                newStyle.marginTop = '6px';
                newStyle.bottom = 'auto';
            } else if (spaceAbove >= dropdownHeight) {
                newStyle.top = 'auto';
                newStyle.bottom = '100%';
                newStyle.marginBottom = '6px';
            } else {
                newStyle.top = '100%';
                newStyle.marginTop = '6px';
                newStyle.bottom = 'auto';
            }

            setDropdownStyle(newStyle);
            requestAnimationFrame(() => {
                setMounted(true);
            });
        } else if (!open) {
            setMounted(false);
        }
    }, [open, options.length]);

    const handleSelect = (key: string) => {
        onChange(key);
        setOpen(false);
        setMounted(false);
    };

    return (
        <div
            ref={wrapperRef}
            className={`${styles.wrapper} ${disabled ? styles.disabled : ''}`}
            style={{
                '--animal-select-cursor': `url("${selectCursor}")`,
            } as React.CSSProperties}
        >
            <div
                className={`${styles.trigger} ${open ? styles.open : ''}`}
                onClick={() => !disabled && setOpen(!open)}
            >
                <span className={value ? styles.value : styles.placeholder}>
                    {currentLabel}
                </span>
                <span className={styles.arrow}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                </span>
            </div>
            {open && mounted && (
                <div className={styles.dropdown} style={dropdownStyle}>
                    {options.map((option) => (
                        <div
                            key={option.key}
                            className={`${styles.option} ${value === option.key ? styles.active : ''} ${hoveredKey === option.key ? styles.hovered : ''}`}
                            onClick={() => handleSelect(option.key)}
                            onMouseEnter={() => setHoveredKey(option.key)}
                            onMouseLeave={() => setHoveredKey(null)}
                        >
                            <span className={styles.optionDot} />
                            {option.label}
                            {value === option.key && <div className={styles.pillBar} />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

Select.displayName = 'Select';
