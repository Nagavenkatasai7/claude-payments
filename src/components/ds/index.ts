// The design-system barrel for new UI. SegmentError is a Client Component and is used through a
// segment's error.tsx re-export, so it is imported from its own module, not from here.
export { Button, buttonVariants, type ButtonProps, type ButtonVariantProps } from './button';
export { Card } from './card';
export { Badge, TONE_CLASSES, type Tone } from './badge';
export { StatusPill } from './status-pill';
export { Money } from './money';
export { Skeleton } from './skeleton';
export { PageHeader } from './page-header';
export { Sidebar, type SidebarItem } from './sidebar';
export { EmptyState } from './empty-state';
export { ErrorState } from './error-state';
export { RouteLoading } from './route-loading';
export { Field, Input, Select, Checkbox, type FieldIds } from './field';
export { Table, type TableColumn } from './table';
// Client Components (each module carries 'use client'):
export { ConfirmDialog } from './confirm-dialog';
export { Toaster, useToast } from './toast';
export { MaskedValue, type RevealAction, type RevealResult } from './masked-value';
export { CommandPalette, type CommandPaletteItem, type CommandPaletteLabels } from './command-palette';
