import content from "../../../docs/legal/privacy-policy.md?raw";
import LegalDoc from "./legal-doc";

export default function Privacy() {
  return <LegalDoc content={content} />;
}
