"use client";

import { useEffect } from "react";

/**
 * 브라우저 뒤로가기(모바일 백 제스처 포함)를 가로채 "페이지를 나가시겠어요?"를 묻는다.
 * beforeunload는 뒤로가기에서 잘 안 뜨므로, 히스토리에 트랩 항목을 하나 넣고
 * popstate를 감지하는 방식으로 확실하게 잡는다.
 *  - 나가기 취소 → 트랩 항목을 다시 넣어 그대로 머무름
 *  - 나가기 확인 → 실제로 뒤로 이동해 페이지를 빠져나감
 */
export default function LeaveGuard() {
  useEffect(() => {
    // 현재 페이지 위에 트랩 항목을 하나 쌓는다(URL은 그대로).
    history.pushState(null, "", location.href);

    const onPop = () => {
      const leave = window.confirm(
        "이 페이지에서 나가시겠어요?\n작성 중인 내용이 있다면 사라질 수 있어요."
      );
      if (leave) {
        window.removeEventListener("popstate", onPop);
        history.back(); // 트랩을 지나 실제 이전 페이지로 이동
      } else {
        // 머무름: 트랩 항목을 다시 쌓아 다음 뒤로가기도 물어보게 함
        history.pushState(null, "", location.href);
      }
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return null;
}
