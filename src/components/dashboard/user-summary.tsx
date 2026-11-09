import { initialOf } from "@/lib/format";
import { cn } from "@/lib/utils";

export type UserSummaryData = { name: string | null; email: string };

export function Avatar({ user, className }: { user: UserSummaryData; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet via-fuchsia to-cyan text-sm font-semibold text-white shadow-[0_0_18px_-4px_rgb(168_85_247/0.7)]",
        className,
      )}
    >
      {initialOf(user.name || user.email)}
    </span>
  );
}

export function UserSummary({ user }: { user: UserSummaryData }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar user={user} />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-medium">{user.name || "Your account"}</p>
        <p className="truncate text-xs text-muted">{user.email}</p>
      </div>
    </div>
  );
}
