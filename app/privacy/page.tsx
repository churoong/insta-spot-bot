export const metadata = { title: "개인정보처리방침 · Insta Spot Bot" };

export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px", lineHeight: 1.8 }}>
      <h1 style={{ fontSize: 24 }}>개인정보처리방침</h1>
      <p style={{ color: "#9aa0ae" }}>Insta Spot Bot (이하 "서비스")</p>

      <h2 style={{ fontSize: 17, marginTop: 28 }}>1. 수집하는 정보</h2>
      <p>
        본 서비스는 한국관광공사 TourAPI의 공개 관광정보를 인스타그램에 게시하는
        자동화 봇입니다. 게시물에 달린 댓글 이벤트(댓글 내용, 작성자 사용자명,
        댓글·미디어 식별자)를 인스타그램 웹훅을 통해 수신합니다.
      </p>

      <h2 style={{ fontSize: 17, marginTop: 28 }}>2. 정보의 이용</h2>
      <p>
        수신한 댓글 정보는 특정 키워드에 대한 자동 안내 메시지(DM) 발송와 중복
        발송 방지 목적으로만 사용됩니다. 그 외 목적으로 이용하거나 제3자에게
        제공하지 않습니다.
      </p>

      <h2 style={{ fontSize: 17, marginTop: 28 }}>3. 정보의 보관</h2>
      <p>
        발송 이력(댓글 식별자, 사용자명)은 중복 발송 방지를 위해 서비스 데이터베이스에
        보관되며, 마케팅·프로파일링 등에 사용되지 않습니다.
      </p>

      <h2 style={{ fontSize: 17, marginTop: 28 }}>4. 사진·정보 출처</h2>
      <p>모든 사진과 장소 정보의 출처는 한국관광공사 TourAPI입니다.</p>

      <h2 style={{ fontSize: 17, marginTop: 28 }}>5. 문의</h2>
      <p>본 방침 관련 문의는 계정 운영자에게 연락해 주세요.</p>

      <p style={{ color: "#9aa0ae", marginTop: 32, fontSize: 13 }}>
        최종 업데이트: 2026-07-15
      </p>
    </main>
  );
}
