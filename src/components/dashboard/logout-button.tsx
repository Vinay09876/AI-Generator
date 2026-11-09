import { LogOut } from "lucide-react";
import { logoutAction } from "@/features/auth/actions";
import { cn } from "@/lib/utils";

/** Works in server and client components: posts to the logout server action. */
export function LogoutButton({ className, showLabel = true }: { className?: string; showLabel?: boolean }) {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        aria-label={showLabel ? undefined : "Log out"}
        className={cn(
          "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-3 text-sm text-muted transition-colors",
          "hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-violet",
          className,
        )}
      >
        <LogOut className="size-4" />
        {showLabel && "Log out"}
      </button>
    </form>
  );
}
