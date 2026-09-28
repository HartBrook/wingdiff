import { pullRequest } from "./fixture";

export default function App() {
  return (
    <main className="prototype-boot">
      <p>Wingdiff · guided review prototype</p>
      <h1>#{pullRequest.number} {pullRequest.title}</h1>
    </main>
  );
}

