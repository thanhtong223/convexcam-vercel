import type { Metadata } from "next";
import { ConvexMirror } from "./ConvexMirror";

export const metadata: Metadata = {
  title: "Convex Cam",
  description: "A bendable mirror in your browser.",
};

export default function Home() {
  return <ConvexMirror />;
}
