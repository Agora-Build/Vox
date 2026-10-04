import { ArrowUpRight, AudioLines, Braces, Heart, Layers, Server, Wrench, type LucideIcon } from "lucide-react";
import { acknowledgmentGroups } from "@/lib/acknowledgments";

const groupIcons: Record<string, LucideIcon> = {
  evaluation: AudioLines,
  interface: Layers,
  platform: Server,
  tooling: Wrench,
  integrations: Braces,
};

export default function Thanks() {
  return (
    <div className="mx-auto max-w-6xl space-y-14 pb-6 md:space-y-20">
      <header className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/70 px-6 py-10 md:px-12 md:py-16">
        <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-rose-400/10 blur-3xl" />
        <div className="relative max-w-3xl space-y-5">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            <Heart aria-hidden="true" className="h-4 w-4 fill-rose-400/20 text-rose-400" />
            Built together
          </p>
          <h1 className="text-5xl font-semibold tracking-tight md:text-7xl">Thanks<span className="text-rose-400">.</span></h1>
          <p className="max-w-2xl text-xl leading-relaxed text-foreground/90 md:text-2xl">
            Open source makes Vox possible. People make open source possible.
          </p>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
            To the maintainers, contributors, and communities behind the projects
            we build on: thank you for sharing your work. These are some of the
            libraries, tools, and services that help bring Vox to life.
          </p>
        </div>
        <nav aria-label="Acknowledgment categories" className="relative mt-8 flex flex-wrap gap-2">
          {acknowledgmentGroups.map((group) => (
            <a key={group.id} href={`#${group.id}`} className="rounded-full border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {group.title}
            </a>
          ))}
        </nav>
      </header>

      {acknowledgmentGroups.map((group) => {
        const Icon = groupIcons[group.id] ?? Heart;
        return (
          <section key={group.id} id={group.id} aria-labelledby={`${group.id}-title`} className="scroll-mt-24">
            <div className="mb-6 flex items-start gap-3 md:gap-4">
              <div className="rounded-lg border border-border bg-secondary/40 p-2.5">
                <Icon aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1.5">
                <h2 id={`${group.id}-title`} className="text-xl font-semibold tracking-tight md:text-2xl">{group.title}</h2>
                <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{group.description}</p>
              </div>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.projects.map((project) => (
                <li key={project.name} className="flex flex-col rounded-xl border border-border/70 bg-card/60 p-5">
                  <a href={project.url} target="_blank" rel="noopener noreferrer" className="group flex items-start justify-between gap-3 rounded-sm text-base font-medium transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                    <span>{project.name}</span>
                    <ArrowUpRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">{project.description}</p>
                  {project.notice && (
                    <a href={project.notice.url} target="_blank" rel="noopener noreferrer" className="mt-4 w-fit rounded-sm text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                      {project.notice.label}<span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <aside aria-label="About these acknowledgments" className="rounded-xl border border-border/70 bg-secondary/20 px-6 py-5 text-sm leading-7 text-muted-foreground">
        <p className="font-medium text-foreground">And to everyone who contributes to Vox: thank you.</p>
        <p className="mt-1">
          This is a curated acknowledgment, not a complete dependency or license
          inventory. Each project retains its own license and each service its
          own terms. Links are credits, not claims of affiliation or endorsement.
        </p>
      </aside>
    </div>
  );
}
