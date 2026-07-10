import content from "../../../docs/legal/terms-of-use.md?raw";
import LegalDoc from "./legal-doc";

export default function Terms() {
  return <LegalDoc content={content} />;
}
