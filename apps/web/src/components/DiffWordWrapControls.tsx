// FILE: DiffWordWrapControls.tsx
// Purpose: The diff word-wrap toggle as a toolbar button and as an options-menu row,
//          shared by the diff panel toolbar and the editor-tab diff controls.
// Layer: Diff panel UI

import { TextWrapIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

import { BUTTON_GROUP_ACTIVE_CLASS_NAME } from "./ui/button-group";
import { IconButton } from "./ui/icon-button";
import { MenuCheckboxItem, MenuShortcut } from "./ui/menu";

interface DiffWordWrapControlProps {
  enabled: boolean;
  shortcutLabel: string | null;
  onChange: (enabled: boolean) => void;
}

export function DiffWordWrapButton(props: DiffWordWrapControlProps & { className?: string }) {
  const { t } = useTranslation();

  const label = t("common:diff_wrapLongLines");
  return (
    <IconButton
      variant="ghost"
      size="icon-xs"
      className={cn(props.className, props.enabled && BUTTON_GROUP_ACTIVE_CLASS_NAME)}
      aria-pressed={props.enabled}
      label={label}
      title={props.shortcutLabel ? `${label} (${props.shortcutLabel})` : label}
      onClick={() => props.onChange(!props.enabled)}
    >
      <TextWrapIcon className="size-3.5" />
    </IconButton>
  );
}

export function DiffWordWrapMenuItem(props: DiffWordWrapControlProps) {
  const { t } = useTranslation();

  return (
    <MenuCheckboxItem
      checked={props.enabled}
      variant="switch"
      onCheckedChange={(checked) => {
        props.onChange(checked === true);
      }}
    >
      <span className="flex w-full items-center gap-2">
        {t("common:diff_wrapLongLines")}
        {props.shortcutLabel ? <MenuShortcut>{props.shortcutLabel}</MenuShortcut> : null}
      </span>
    </MenuCheckboxItem>
  );
}
