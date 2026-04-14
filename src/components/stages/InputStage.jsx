import { TA } from "../../shared.jsx";
import { FieldBox, Heading, PrimaryBtn } from "../Buttons.jsx";
import { DropZone } from "../DropZone.jsx";
import { PhotoDropZone } from "../PhotoDropZone.jsx";
import { ClientPlanInput } from "../ClientPlanInput.jsx";

export function InputStage({
  tplText, setTplText, clientPlan, setClientPlan, comment, setComment,
  fileLabel, fileB64, methodInfo, photos, setPhotos, info, running, loadMsg,
  handleFile, doAnalyze, setStage,
}) {
  return (
    <div className="fade">
      <Heading>01 / Введіть дані замовлення</Heading>
      <FieldBox label="Шаблон замовлення *">
        <textarea value={tplText} onChange={e => setTplText(e.target.value)}
          placeholder={"№ замовлення - 34455\nТип - Магістерська\n⏰Дедлайн - 06.03.2026\n⚡️Напрям - Гуманітарне\n📌Тематика - Психологія\n✈️Тема - Вплив гаджетів на когнітивну поведінку дітей\n⚙️К-кість стр. - 100-120\n⚙️Унікальність - 70-80%"}
          style={{ ...TA, minHeight: 200 }} />
      </FieldBox>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <FieldBox label="Готовий план від клієнта (необов'язково)">
          <textarea value={clientPlan} onChange={e => setClientPlan(e.target.value)}
            placeholder="Вставте план клієнта якщо є. Порожньо = план згенерується автоматично."
            style={{ ...TA, minHeight: 90 }} />
        </FieldBox>
        <FieldBox label="Або фото плану">
          <ClientPlanInput onExtracted={setClientPlan} extracted={clientPlan} />
        </FieldBox>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <FieldBox label="Коментар">
          <textarea value={comment} onChange={e => setComment(e.target.value)}
            placeholder="Додаткові побажання..." style={{ ...TA, minHeight: 90 }} />
        </FieldBox>
        <FieldBox label="Методичка (тільки PDF)">
          <DropZone fileLabel={fileLabel} onFile={handleFile} />
          {methodInfo && !fileB64 && (
            <div style={{ fontSize: 11, color: "#7a8a5a", marginTop: 5 }}>
              ✓ Методичку вже проаналізовано. Завантажте PDF знову лише якщо потрібно перепроаналізувати.
            </div>
          )}
        </FieldBox>
      </div>
      <FieldBox label="Фото як додатковий матеріал (необов'язково)">
        <PhotoDropZone
          photos={photos}
          onAdd={p => setPhotos(prev => [...prev, p])}
          onRemove={i => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
        />
      </FieldBox>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <PrimaryBtn onClick={doAnalyze} disabled={!tplText.trim()} loading={running} msg={loadMsg} label="Аналізувати →" />
        {info && !running && (
          <button onClick={() => setStage("parsed")}
            style={{ background: "transparent", border: "1.5px solid #555", color: "#555", borderRadius: 8, padding: "11px 22px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            Продовжити без повторного аналізу →
          </button>
        )}
      </div>
    </div>
  );
}
