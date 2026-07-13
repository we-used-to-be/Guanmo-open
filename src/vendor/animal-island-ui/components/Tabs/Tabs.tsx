import React, { useState } from 'react';
import styles from './tabs.module.css';
import leafIcon from '../../assets/img/icons/icon-leaf.png?inline';

export interface TabItem {
    key: string;
    label: React.ReactNode;
    children: React.ReactNode;
}

export interface TabsProps {
    items: TabItem[];
    defaultActiveKey?: string;
    activeKey?: string;
    onChange?: (key: string) => void;
    className?: string;
    style?: React.CSSProperties;
    leafAnimation?: boolean;
    shadow?: boolean;
}

export const Tabs: React.FC<TabsProps> = ({
    items,
    defaultActiveKey,
    activeKey,
    onChange,
    className,
    style,
    leafAnimation = true,
    shadow = true,
}) => {
    const [internalActiveKey, setInternalActiveKey] = useState(
        defaultActiveKey || items[0]?.key
    );

    const currentActiveKey = activeKey !== undefined ? activeKey : internalActiveKey;

    const handleTabClick = (key: string) => {
        if (activeKey === undefined) {
            setInternalActiveKey(key);
        }
        onChange?.(key);
    };

    const activeItem = items.find((item) => item.key === currentActiveKey);

    const cls = [styles.tabs, className].filter(Boolean).join(' ');

    return (
        <div className={cls} style={style}>
            <div className={styles.tabList} role="tablist">
                {items.map((item) => {
                    const isActive = item.key === currentActiveKey;
                    return (
                        <button
                            key={item.key}
                            className={`${styles.tabItem} ${isActive ? styles.active : ''} ${isActive && shadow ? styles['active-shadow'] : ''}`}
                            onClick={() => handleTabClick(item.key)}
                            role="tab"
                            aria-selected={isActive}
                        >
                            <span className={styles.tabIcon}>
                                {isActive ? '●' : '○'}
                            </span>
                            <span className={styles.tabLabel}>{item.label}</span>
                            {isActive && <img src={leafIcon} alt="" className={`${styles.tabLeaf} ${leafAnimation ? '' : styles.tabLeafStatic}`} />}
                        </button>
                    );
                })}
            </div>
            <div className={styles.tabContent}>
                <div className={styles.tabContentInner}>
                    {activeItem?.children}
                </div>
            </div>
        </div>
    );
};

Tabs.displayName = 'Tabs';
