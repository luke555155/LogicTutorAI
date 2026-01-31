/**
 * LogicTutorAI - 測驗作答系統
 * 完整 JavaScript 邏輯
 *
 * 注意：此文件包含所有 JavaScript 邏輯。
 * 後續可按以下方式進一步拆分：
 * - ui.js: 所有 UI 更新和 DOM 操作（renderQuestion, updateStats 等）
 * - handlers.js: 所有事件處理器（selectSingleOption, submitMultipleChoice 等）
 * - main.js: 全域狀態和核心邏輯（保留）
 */

// ==================== 全域狀態 ====================
let questions = [];           // 所有題目
let currentIndex = 0;         // 當前題目索引
let showChinese = false;      // 是否顯示中文
let answerState = {};         // 答題狀態 { questionNum: 'correct' | 'wrong' }
let selectedOptions = [];     // 多選題已選選項
let hasAnswered = false;      // 當前題目是否已作答
let randomJumpEnabled = false; // 隨機跳題功能
let keywordHighlightEnabled = true; // 關鍵字高亮功能（預設啟用）

// 閱讀範圍設定
let rangeEnabled = false;     // 是否啟用範圍限制
let rangeStart = 1;           // 起始題號
let rangeEnd = null;          // 結束題號（null 表示到最後一題）
let showImportantOnly = false; // 是否僅顯示重要題目

// 題型過濾設定
let enabledQuestionTypes = ['單選題', '多選題', '簡答題'];

// GROQ AI 設定
let groqApiKey = '';          // GROQ API Key
let groqModel = 'openai/gpt-oss-20b';  // 預設模型
let availableModels = [];     // 可用模型列表

// ==================== 題庫解析器 ====================
/**
 * 解析 Markdown 題庫檔案
 * @param {string} markdown - Markdown 原始內容
 * @returns {Array} 題目陣列
 */
function parseQuestions(markdown) {
    const questions = [];
    // 以 --- 分隔各題
    const blocks = markdown.split(/---/).filter(block => block.trim());

    for (const block of blocks) {
        // 解析題號與題型（支援 ## *第 XXX 題 格式，星號表示重要題目）
        // 支援：單選題、多選題、簡答題
        const headerMatch = block.match(/##\s*(\*)?\s*第\s*(\d+)\s*題\s*【(單選題|多選題|簡答題)】/);
        if (!headerMatch) continue;

        const isImportant = headerMatch[1] === '*';
        const questionNum = parseInt(headerMatch[2]);
        const questionType = headerMatch[3];
        const isMultiple = questionType === '多選題';
        const isShortAnswer = questionType === '簡答題';

        // 解析英文題目
        const englishMatch = block.match(/\*\*English:\*\*\s*([\s\S]*?)(?=\*\*中文：\*\*)/);
        const englishText = englishMatch ? englishMatch[1].trim() : '';

        // 解析中文題目（簡答題可能後接 **圖片** 或 **參考答案**）
        const chineseMatch = block.match(/\*\*中文：\*\*\s*([\s\S]*?)(?=(?:\!\[圖片\]|\*\*圖片\*\*|\*\*選項：\*\*|\*\*參考答案\*\*))/);
        const chineseText = chineseMatch ? chineseMatch[1].trim() : '';

        // 解析圖片（支援多張，支援兩種格式：直接 ![圖片] 或 **圖片** 區塊下的 ![圖片]）
        const imageMatches = [...block.matchAll(/!\[圖片\]\((.*?)\)/g)];
        const imagePaths = imageMatches.map(m => m[1]);

        let options = [];
        let correctAnswer = '';
        let shortAnswer = null;

        if (isShortAnswer) {
            // 簡答題：解析參考答案區塊
            const shortAnswerMatch = block.match(/\*\*參考答案\*\*\s*([\s\S]*?)(?=(?:\*\*題目解析\*\*|$))/);
            shortAnswer = shortAnswerMatch ? shortAnswerMatch[1].trim() : null;
        } else {
            // 選擇題：解析選項
            const optionsMatch = block.match(/\*\*選項：\*\*\s*([\s\S]*?)(?=\*\*正確答案)/);
            const optionsText = optionsMatch ? optionsMatch[1].trim() : '';
            const optionLines = optionsText.split('\n').filter(line => line.trim().startsWith('-'));

            options = optionLines.map(line => {
                // 移除開頭的 "- " 並解析選項
                const cleaned = line.replace(/^-\s*/, '').trim();
                const letterMatch = cleaned.match(/^([A-F])\.\s*(.*)/);
                if (letterMatch) {
                    return {
                        letter: letterMatch[1],
                        text: letterMatch[2]
                    };
                }
                return null;
            }).filter(opt => opt !== null);

            // 解析正確答案（支援連續格式 AB 或逗號分隔格式 A,B）
            const answerMatch = block.match(/\*\*正確答案：([A-F,]+)\*\*/);
            // 移除逗號，統一為連續字母格式（例如 A,B -> AB）
            correctAnswer = answerMatch ? answerMatch[1].replace(/,/g, '') : '';
        }

        // 解析題目解析（可選欄位）
        const explanationMatch = block.match(/\*\*題目解析\*\*\s*([\s\S]*?)(?=$)/);
        const explanation = explanationMatch ? explanationMatch[1].trim() : null;

        questions.push({
            number: questionNum,
            type: questionType,
            isMultiple,
            isShortAnswer,
            isImportant,
            englishText,
            chineseText,
            imagePaths,
            options,
            correctAnswer,
            shortAnswer,
            explanation
        });
    }

    // 依題號排序
    questions.sort((a, b) => a.number - b.number);
    return questions;
}

// ==================== 題庫載入 ====================
/**
 * 嘗試自動載入同目錄下的題庫檔案
 * 注意：使用本地 file:/// 協議會出現 CORS 錯誤，建議使用 HTTP 伺服器
 * 例如：python -m http.server 8000，然後訪問 http://localhost:8000
 */
async function autoLoadQuestions() {
    try {
        const response = await fetch('database.md');
        if (response.ok) {
            const markdown = await response.text();
            questions = parseQuestions(markdown);
            if (questions.length > 0) {
                loadSavedProgress();
                initQuiz();
                return;
            }
        }
    } catch (e) {
        console.log('自動載入失敗，等待手動選擇檔案');
    }
    // 顯示空狀態
    showEmptyState();
}

/**
 * 從檔案輸入載入題庫（支援多檔案合併）
 */
async function loadFileFromInput(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    showLoadingState();

    try {
        // 讀取所有檔案內容
        const readFile = (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = (e) => reject(e);
                reader.readAsText(file);
            });
        };

        // 並行讀取所有檔案
        const contents = await Promise.all(
            Array.from(files).map(file => readFile(file))
        );

        // 合併所有 MD 內容（用 --- 分隔符連接）
        const mergedMarkdown = contents.join('\n\n---\n\n');

        questions = parseQuestions(mergedMarkdown);
        if (questions.length > 0) {
            loadSavedProgress();
            initQuiz();
            console.log(`成功載入 ${files.length} 個檔案，共 ${questions.length} 題`);
        } else {
            alert('無法解析題庫檔案，請確認格式正確');
            showEmptyState();
        }
    } catch (error) {
        console.error('載入檔案時發生錯誤:', error);
        alert('載入檔案時發生錯誤，請重試');
        showEmptyState();
    }

    // 清空 file input，讓使用者可以再次選擇相同檔案
    event.target.value = '';
}

/**
 * 重新載入題庫
 */
async function reloadQuestions() {
    showLoadingState();
    try {
        const response = await fetch('database.md', { cache: 'no-cache' });
        if (response.ok) {
            const markdown = await response.text();
            questions = parseQuestions(markdown);
            if (questions.length > 0) {
                loadSavedProgress();
                initQuiz();
                return;
            }
        }
    } catch (e) {
        console.log('重新載入失敗');
    }
    alert('重新載入失敗，請使用「載入題庫」按鈕手動選擇檔案');
    showQuizContainer();
}

// ==================== UI 狀態管理 ====================
function showLoadingState() {
    document.getElementById('loadingState').classList.remove('hidden');
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('quizContainer').classList.add('hidden');
}

function showEmptyState() {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('quizContainer').classList.add('hidden');
}

function showQuizContainer() {
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('quizContainer').classList.remove('hidden');
}

// ==================== 題目初始化與渲染 ====================
/**
 * 初始化測驗
 */
function initQuiz() {
    showQuizContainer();
    generateAnswerCard();
    renderQuestion();
    updateStats();
    updateJumpInputMax();
}

/**
 * 生成答題卡格子
 */
function generateAnswerCard() {
    const container = document.getElementById('answerCard');
    container.innerHTML = '';

    for (let i = 0; i < questions.length; i++) {
        const num = questions[i].number;
        const div = document.createElement('div');
        div.className = 'answer-card-item w-8 h-8 flex items-center justify-center text-xs font-medium rounded cursor-pointer transition-colors';
        div.textContent = num;
        div.dataset.index = i;

        // 設定顏色
        updateCardItemColor(div, num);

        // 點擊跳轉
        div.onclick = () => {
            currentIndex = i;
            renderQuestion();
        };

        container.appendChild(div);
    }
}

/**
 * 更新答題卡格子顏色
 */
function updateCardItemColor(element, questionNum) {
    const state = answerState[questionNum];
    // 找到對應的題目檢查是否為簡答題
    const question = questions.find(q => q.number === questionNum);
    const isShortAnswer = question && question.isShortAnswer;

    element.classList.remove('bg-green-500', 'bg-red-500', 'bg-slate-600', 'bg-emerald-700', 'text-white', 'text-slate-400', 'text-slate-300', 'border', 'border-emerald-500');

    if (isShortAnswer) {
        // 簡答題使用特殊顏色（深綠色邊框）
        element.classList.add('bg-slate-700', 'text-emerald-400', 'border', 'border-emerald-500');
    } else if (state === 'correct') {
        element.classList.add('bg-green-500', 'text-white');
    } else if (state === 'wrong') {
        element.classList.add('bg-red-500', 'text-white');
    } else {
        element.classList.add('bg-slate-600', 'text-slate-300');
    }
}

/**
 * 更新單一答題卡格子
 */
function updateSingleCardItem(questionNum) {
    const container = document.getElementById('answerCard');
    const items = container.querySelectorAll('.answer-card-item');
    items.forEach(item => {
        if (parseInt(item.textContent) === questionNum) {
            updateCardItemColor(item, questionNum);
        }
    });
}

/**
 * 渲染當前題目
 */
function renderQuestion() {
    if (questions.length === 0) return;

    const q = questions[currentIndex];
    hasAnswered = !!answerState[q.number];
    selectedOptions = [];

    // 隱藏 AI 解析區塊（切換題目時重設）
    document.getElementById('aiAnalysisSection').classList.add('hidden');

    // 關閉解析面板（切換題目時重設）
    if (isExplanationPanelOpen) {
        closeExplanationPanel();
    }

    // 顯示/隱藏解析提示按鈕（只有有解析的題目才顯示）
    const explanationBtn = document.getElementById('explanationBtn');
    const importantBadge = document.getElementById('importantBadge');
    if (q.explanation) {
        explanationBtn.classList.remove('hidden');
        explanationBtn.classList.add('flex');
    } else {
        explanationBtn.classList.add('hidden');
        explanationBtn.classList.remove('flex');
    }

    // 顯示/隱藏重要標籤（題目標題有星號時顯示）
    if (importantBadge) {
        if (q.isImportant) {
            importantBadge.classList.remove('hidden');
        } else {
            importantBadge.classList.add('hidden');
        }
    }

    // 更新題號
    document.getElementById('questionNumber').textContent = `第 ${q.number} 題 / ${questions.length} 題`;

    // 更新題型
    const typeEl = document.getElementById('questionType');
    typeEl.textContent = q.type;
    // 簡答題用綠色、多選題用紫色、單選題用藍色
    let typeClass = 'bg-blue-600/20 text-blue-400';
    if (q.isShortAnswer) {
        typeClass = 'bg-green-600/20 text-green-400';
    } else if (q.isMultiple) {
        typeClass = 'bg-purple-600/20 text-purple-400';
    }
    typeEl.className = 'px-2 sm:px-3 py-0.5 sm:py-1 rounded-full text-xs sm:text-sm font-medium ' + typeClass;

    // 顯示/隱藏查看圖片按鈕（附圖片題才顯示）
    const viewImageBtn = document.getElementById('viewImageBtn');
    if (q.imagePaths && q.imagePaths.length > 0) {
        viewImageBtn.classList.remove('hidden');
        viewImageBtn.classList.add('flex');
        // 更新按鈕文字顯示圖片數量
        const btnText = viewImageBtn.querySelector('span');
        btnText.textContent = q.imagePaths.length > 1 ? `查看圖片 (${q.imagePaths.length})` : '查看圖片';
        // 生成 Dialog 圖片內容
        const imageWrapper = document.getElementById('imageWrapper');
        imageWrapper.innerHTML = q.imagePaths.map((path, index) => `
            <div class="w-full flex flex-col items-center">
                ${q.imagePaths.length > 1 ? `<p class="text-sm text-slate-400 mb-2">圖片 ${index + 1} / ${q.imagePaths.length}</p>` : ''}
                <img src="${path}" alt="題目圖片 ${index + 1}"
                     class="max-w-full object-contain select-none shadow-2xl rounded border border-slate-700"
                     draggable="false">
            </div>
        `).join('');
    } else {
        viewImageBtn.classList.add('hidden');
        viewImageBtn.classList.remove('flex');
    }

    // 顯示內嵌圖片區域（題目下方直接顯示）
    const imageContainer = document.getElementById('questionImage');
    if (q.imagePaths && q.imagePaths.length > 0) {
        imageContainer.classList.remove('hidden');
        imageContainer.innerHTML = q.imagePaths.map((path, index) => `
            <div class="flex flex-col items-center">
                ${q.imagePaths.length > 1 ? `<p class="text-sm text-slate-400 mb-2">圖片 ${index + 1} / ${q.imagePaths.length}</p>` : ''}
                <img src="${path}" alt="題目圖片 ${index + 1}"
                     class="max-w-full rounded-lg border border-slate-600 shadow-lg cursor-pointer hover:border-blue-500 transition-colors"
                     onclick="openImageDialog()"
                     title="點擊放大查看">
            </div>
        `).join('');
    } else {
        imageContainer.classList.add('hidden');
        imageContainer.innerHTML = '';
    }

    // 顯示題目文字（支援反引號關鍵字高亮）
    const questionText = showChinese ? q.chineseText : q.englishText;
    document.getElementById('questionText').innerHTML = highlightKeywords(questionText);

    // 更新翻譯按鈕狀態
    document.getElementById('translateBtnText').textContent = showChinese ? '顯示英文原文' : '顯示中文翻譯';

    // 渲染選項（簡答題則渲染查看答案按鈕）
    renderOptions(q);

    // 顯示/隱藏多選題提交按鈕（簡答題不顯示）
    const submitBtnContainer = document.getElementById('submitBtnContainer');
    if (q.isMultiple && !hasAnswered && !q.isShortAnswer) {
        submitBtnContainer.classList.remove('hidden');
    } else {
        submitBtnContainer.classList.add('hidden');
    }

    // 顯示/隱藏簡答題查看答案區塊
    const shortAnswerSection = document.getElementById('shortAnswerSection');
    if (shortAnswerSection) {
        if (q.isShortAnswer) {
            shortAnswerSection.classList.remove('hidden');
            // 重設答案顯示狀態
            const shortAnswerContent = document.getElementById('shortAnswerContent');
            const showAnswerBtn = document.getElementById('showAnswerBtn');
            if (shortAnswerContent && showAnswerBtn) {
                shortAnswerContent.classList.add('hidden');
                showAnswerBtn.classList.remove('hidden');
            }
        } else {
            shortAnswerSection.classList.add('hidden');
        }
    }

    // 隱藏結果訊息
    document.getElementById('resultMessage').classList.add('hidden');

    // 更新導航按鈕狀態
    document.getElementById('prevBtn').disabled = currentIndex === 0;
    document.getElementById('nextBtn').disabled = currentIndex === questions.length - 1;

    // 更新跳題輸入框
    document.getElementById('jumpInput').value = q.number;

    // 如果已作答，顯示結果
    if (hasAnswered) {
        showAnswerResult(q, answerState[q.number] === 'correct');
    }
}

/**
 * 渲染選項
 */
function renderOptions(question) {
    const container = document.getElementById('optionsContainer');
    container.innerHTML = '';

    // 簡答題不渲染選項
    if (question.isShortAnswer) {
        return;
    }

    const correctLetters = question.correctAnswer.split('');

    question.options.forEach(opt => {
        const isCorrect = correctLetters.includes(opt.letter);

        const div = document.createElement('div');
        div.className = 'option-btn flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all';
        div.dataset.letter = opt.letter;

        // 根據已作答狀態設定樣式
        if (hasAnswered) {
            div.classList.add('answered', 'cursor-default');
            if (isCorrect) {
                div.classList.add('border-green-500', 'bg-green-500/10');
            } else {
                div.classList.add('border-slate-600', 'bg-slate-800/50');
            }
        } else {
            div.classList.add('border-slate-600', 'bg-slate-800/50', 'hover:border-blue-500');
        }

        // 多選題使用核取方塊
        if (question.isMultiple) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'checkbox-custom';
            checkbox.disabled = hasAnswered;
            checkbox.dataset.letter = opt.letter;
            checkbox.onchange = (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    selectedOptions.push(opt.letter);
                } else {
                    selectedOptions = selectedOptions.filter(l => l !== opt.letter);
                }
            };
            div.appendChild(checkbox);

            // 雙擊選項切換核取方塊（避免誤觸）
            if (!hasAnswered) {
                div.ondblclick = () => {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                };
            }
        } else {
            // 單選題使用圓形指示器
            const indicator = document.createElement('div');
            indicator.className = 'w-8 h-8 rounded-full border-2 flex items-center justify-center font-bold text-sm shrink-0';
            if (hasAnswered && isCorrect) {
                indicator.classList.add('border-green-500', 'bg-green-500', 'text-white');
            } else {
                indicator.classList.add('border-slate-500', 'text-slate-400');
            }
            indicator.textContent = opt.letter;
            div.appendChild(indicator);

            // 單選題雙擊事件（避免誤觸）
            if (!hasAnswered) {
                div.ondblclick = () => selectSingleOption(opt.letter, question);
            }
        }

        // 選項文字（支援反引號關鍵字高亮）
        const textSpan = document.createElement('span');
        textSpan.className = 'flex-1';
        // 解析選項中的中英文
        if (showChinese) {
            // 嘗試提取中文部分（括號內）
            const chineseMatch = opt.text.match(/（(.+?)）/);
            const displayText = chineseMatch ? `${opt.letter}. ${chineseMatch[1]}` : `${opt.letter}. ${opt.text}`;
            textSpan.innerHTML = highlightKeywords(displayText);
        } else {
            // 只顯示英文部分
            const englishText = opt.text.replace(/（.+?）/, '').trim();
            const displayText = `${opt.letter}. ${englishText}`;
            textSpan.innerHTML = highlightKeywords(displayText);
        }
        div.appendChild(textSpan);

        container.appendChild(div);
    });
}

/**
 * 單選題選擇選項
 */
function selectSingleOption(letter, question) {
    if (hasAnswered) return;

    const isCorrect = letter === question.correctAnswer;
    hasAnswered = true;
    answerState[question.number] = isCorrect ? 'correct' : 'wrong';

    saveProgress();
    updateSingleCardItem(question.number);
    updateStats();

    // 重新渲染選項以顯示結果
    renderOptions(question);
    showAnswerResult(question, isCorrect, letter);

    // 答對自動跳下一題
    if (isCorrect) {
        // 隨機跳題模式：檢查是否還有可跳題目
        // 一般模式：檢查是否還有下一題
        const canJump = randomJumpEnabled ? getRandomNextIndex() !== -1 : currentIndex < questions.length - 1;
        if (canJump) {
            setTimeout(() => {
                nextQuestion();
            }, 800);
        }
    }
}

/**
 * 多選題提交答案
 */
function submitMultipleChoice() {
    const q = questions[currentIndex];
    if (hasAnswered || selectedOptions.length === 0) return;

    // 排序後比較
    const userAnswer = selectedOptions.sort().join('');
    const correctAnswer = q.correctAnswer.split('').sort().join('');
    const isCorrect = userAnswer === correctAnswer;

    hasAnswered = true;
    answerState[q.number] = isCorrect ? 'correct' : 'wrong';

    saveProgress();
    updateSingleCardItem(q.number);
    updateStats();

    // 隱藏提交按鈕
    document.getElementById('submitBtnContainer').classList.add('hidden');

    // 重新渲染選項以顯示結果
    renderOptions(q);
    showAnswerResult(q, isCorrect, userAnswer);

    // 答對自動跳下一題
    if (isCorrect) {
        // 隨機跳題模式：檢查是否還有可跳題目
        // 一般模式：檢查是否還有下一題
        const canJump = randomJumpEnabled ? getRandomNextIndex() !== -1 : currentIndex < questions.length - 1;
        if (canJump) {
            setTimeout(() => {
                nextQuestion();
            }, 800);
        }
    }
}

/**
 * 簡答題：顯示參考答案
 */
function showShortAnswer() {
    const q = questions[currentIndex];
    if (!q || !q.isShortAnswer) return;

    const showAnswerBtn = document.getElementById('showAnswerBtn');
    const shortAnswerContent = document.getElementById('shortAnswerContent');

    if (showAnswerBtn && shortAnswerContent) {
        showAnswerBtn.classList.add('hidden');
        shortAnswerContent.classList.remove('hidden');

        // 使用 marked.js 渲染 Markdown 內容（支援表格等格式）
        if (q.shortAnswer) {
            if (typeof marked !== 'undefined') {
                shortAnswerContent.innerHTML = marked.parse(q.shortAnswer);
            } else {
                // 如果 marked.js 未載入，直接顯示原始內容
                shortAnswerContent.innerHTML = `<pre class="whitespace-pre-wrap">${q.shortAnswer}</pre>`;
            }
        } else {
            shortAnswerContent.innerHTML = '<p class="text-slate-400">此題無參考答案</p>';
        }
    }
}

/**
 * 簡答題：隱藏參考答案
 */
function hideShortAnswer() {
    const showAnswerBtn = document.getElementById('showAnswerBtn');
    const shortAnswerContent = document.getElementById('shortAnswerContent');

    if (showAnswerBtn && shortAnswerContent) {
        showAnswerBtn.classList.remove('hidden');
        shortAnswerContent.classList.add('hidden');
    }
}

/**
 * 顯示答題結果
 */
function showAnswerResult(question, isCorrect, userAnswer = '') {
    const resultEl = document.getElementById('resultMessage');
    resultEl.classList.remove('hidden');

    if (isCorrect) {
        resultEl.className = 'mt-6 p-4 rounded-xl bg-green-500/20 border border-green-500/50';
        resultEl.innerHTML = `
            <div class="flex items-center gap-2 text-green-400 font-semibold">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
                答對了！
            </div>
        `;
    } else {
        resultEl.className = 'mt-6 p-4 rounded-xl bg-red-500/20 border border-red-500/50';
        resultEl.innerHTML = `
            <div class="flex items-center gap-2 text-red-400 font-semibold mb-2">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
                答錯了！
            </div>
            <p class="text-slate-300">
                正確答案：<span class="text-green-400 font-bold">${question.correctAnswer}</span>
            </p>
        `;
    }
}

// ==================== 導航功能 ====================

/**
 * 取得有效的題目範圍（考慮閱讀範圍設定）
 */
function getValidRange() {
    if (!rangeEnabled || questions.length === 0) {
        return {
            startIdx: 0,
            endIdx: questions.length - 1,
            startNum: questions[0]?.number || 1,
            endNum: questions[questions.length - 1]?.number || 1
        };
    }

    // 找到範圍內的起始和結束索引
    const effectiveEnd = rangeEnd || questions[questions.length - 1].number;
    let startIdx = questions.findIndex(q => q.number >= rangeStart);
    let endIdx = questions.findIndex(q => q.number > effectiveEnd);

    if (startIdx === -1) startIdx = 0;
    if (endIdx === -1) endIdx = questions.length;
    endIdx = endIdx - 1;

    // 確保有效範圍
    if (startIdx > endIdx) {
        startIdx = 0;
        endIdx = questions.length - 1;
    }

    return {
        startIdx,
        endIdx,
        startNum: questions[startIdx]?.number || 1,
        endNum: questions[endIdx]?.number || 1
    };
}

/**
 * 檢查當前題目是否在有效範圍內
 */
function isInValidRange(index) {
    const range = getValidRange();
    return index >= range.startIdx && index <= range.endIdx;
}

/**
 * 取得有效的題目索引列表（考慮閱讀範圍、僅顯示重要題目和題型過濾設定）
 */
function getValidIndices() {
    if (questions.length === 0) return [];

    const range = getValidRange();
    const indices = [];

    for (let i = range.startIdx; i <= range.endIdx; i++) {
        const q = questions[i];
        // 過濾1：僅顯示重要題目
        if (showImportantOnly && !q.isImportant) {
            continue;
        }
        // 過濾2：題型過濾
        if (!enabledQuestionTypes.includes(q.type)) {
            continue;
        }
        indices.push(i);
    }

    return indices;
}

/**
 * 檢查索引是否在有效索引列表中
 */
function isValidIndex(index) {
    if (!showImportantOnly) {
        return isInValidRange(index);
    }
    return getValidIndices().includes(index);
}

/**
 * 上一題
 */
function prevQuestion() {
    const validIndices = getValidIndices();
    if (validIndices.length === 0) return;

    // 找到當前索引在有效索引列表中的位置
    const currentPos = validIndices.indexOf(currentIndex);

    if (currentPos === -1) {
        // 當前不在有效範圍內，跳到最後一個有效題目
        currentIndex = validIndices[validIndices.length - 1];
    } else if (currentPos > 0) {
        // 跳到前一個有效題目
        currentIndex = validIndices[currentPos - 1];
    }
    // 如果已經是第一題，不做任何動作

    renderQuestion();
}

/**
 * 下一題
 */
function nextQuestion() {
    const validIndices = getValidIndices();
    if (validIndices.length === 0) return;

    // 找到當前索引在有效索引列表中的位置
    const currentPos = validIndices.indexOf(currentIndex);

    // 如果啟用隨機跳題
    if (randomJumpEnabled) {
        const nextIdx = getRandomNextIndex();
        if (nextIdx !== -1) {
            currentIndex = nextIdx;
            renderQuestion();
        }
        // 如果沒有可跳題目，不做任何動作
        return;
    }

    if (currentPos === -1) {
        // 當前不在有效範圍內，跳到第一個有效題目
        currentIndex = validIndices[0];
    } else if (currentPos < validIndices.length - 1) {
        // 跳到下一個有效題目
        currentIndex = validIndices[currentPos + 1];
    }
    // 如果已經是最後一題，不做任何動作

    renderQuestion();
}

/**
 * 隨機跳題 - 獲取下一個未作答題目的索引
 */
function getRandomNextIndex() {
    const validIndices = getValidIndices();
    const unanswered = [];

    for (const i of validIndices) {
        const q = questions[i];
        if (!answerState[q.number]) {
            unanswered.push(i);
        }
    }

    if (unanswered.length === 0) return -1;
    return unanswered[Math.floor(Math.random() * unanswered.length)];
}

/**
 * 快速跳題
 */
function jumpToQuestion() {
    const input = document.getElementById('jumpInput');
    const num = parseInt(input.value);

    // 尋找對應題號的索引
    const index = questions.findIndex(q => q.number === num);
    if (index !== -1) {
        const q = questions[index];

        // 檢查是否在範圍內
        if (rangeEnabled && !isInValidRange(index)) {
            const range = getValidRange();
            alert(`題目 ${num} 不在設定的閱讀範圍內（第 ${range.startNum} ~ ${range.endNum} 題）`);
            return;
        }

        // 檢查是否為重要題目（如果啟用僅顯示重要題目）
        if (showImportantOnly && !q.isImportant) {
            alert(`題目 ${num} 不是重要題目，目前僅顯示重要題目`);
            return;
        }

        // 檢查題型是否啟用
        if (!enabledQuestionTypes.includes(q.type)) {
            const typeNames = enabledQuestionTypes.join('、');
            alert(`題目 ${num} 是「${q.type}」，目前僅顯示：${typeNames}`);
            return;
        }

        currentIndex = index;
        renderQuestion();
    } else {
        alert(`找不到第 ${num} 題`);
    }
}

/**
 * 更新跳題輸入框最大值
 */
function updateJumpInputMax() {
    const input = document.getElementById('jumpInput');
    if (questions.length > 0) {
        input.max = questions[questions.length - 1].number;
    }
}

// ==================== 翻譯切換 ====================
function toggleTranslation() {
    showChinese = !showChinese;
    renderQuestion();
}

// ==================== 統計功能 ====================
function updateStats() {
    let correct = 0;
    let wrong = 0;

    for (const num in answerState) {
        if (answerState[num] === 'correct') correct++;
        else if (answerState[num] === 'wrong') wrong++;
    }

    const total = correct + wrong;
    const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : 0;

    document.getElementById('correctCount').textContent = correct;
    document.getElementById('wrongCount').textContent = wrong;
    document.getElementById('accuracy').textContent = accuracy + '%';

    // 計算可作答題數（不含簡答題）
    const answerableQuestions = questions.filter(q => !q.isShortAnswer).length;
    const shortAnswerCount = questions.length - answerableQuestions;

    // 更新進度條（簡答題不計入）
    const progressPercent = answerableQuestions > 0 ? (total / answerableQuestions) * 100 : 0;
    document.getElementById('progressBar').style.width = progressPercent + '%';

    // 進度文字顯示（如有簡答題則標註）
    let progressText = `已作答 ${total} / ${answerableQuestions} 題`;
    if (shortAnswerCount > 0) {
        progressText += ` (另有 ${shortAnswerCount} 題簡答)`;
    }
    document.getElementById('progressText').textContent = progressText;
}

// ==================== 進度儲存 ====================
function saveProgress() {
    localStorage.setItem('sy0701_answerState', JSON.stringify(answerState));
    localStorage.setItem('sy0701_currentIndex', currentIndex.toString());
}

function loadSavedProgress() {
    try {
        const saved = localStorage.getItem('sy0701_answerState');
        if (saved) {
            answerState = JSON.parse(saved);
        }
        const savedIndex = localStorage.getItem('sy0701_currentIndex');
        if (savedIndex !== null) {
            currentIndex = parseInt(savedIndex);
            // 確保索引在有效範圍內
            if (currentIndex >= questions.length) {
                currentIndex = 0;
            }
        }
    } catch (e) {
        console.log('載入進度失敗');
    }
}

function resetProgress() {
    if (confirm('確定要重設所有答題進度嗎？')) {
        answerState = {};
        currentIndex = 0;
        localStorage.removeItem('sy0701_answerState');
        localStorage.removeItem('sy0701_currentIndex');
        generateAnswerCard();
        renderQuestion();
        updateStats();
    }
}

// ==================== 工具函式 ====================
/**
 * HTML 轉義
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 處理 Markdown 反引號關鍵字高亮
 * 將 `關鍵字` 轉換為紅色顯示
 * @param {string} text - 原始文字
 * @returns {string} 處理後的 HTML
 */
function highlightKeywords(text) {
    // 先轉義 HTML 特殊字元
    const escaped = escapeHtml(text);

    // 如果關鍵字高亮功能已停用，只移除反引號但不套用樣式
    if (!keywordHighlightEnabled) {
        return escaped.replace(/`([^`]+)`/g, '$1');
    }

    // 將反引號包裹的文字轉換為紅色 span
    // 支援多個關鍵字：`keyword1` 和 `keyword2` 等
    return escaped.replace(/`([^`]+)`/g, '<span class="text-red-400 font-semibold">$1</span>');
}

// ==================== 解析面板控制（懸浮視窗） ====================
let isExplanationPanelOpen = false;
let explanationPanelDragging = false;
let explanationPanelOffsetX = 0;
let explanationPanelOffsetY = 0;

/**
 * 初始化懸浮解析視窗拖曳功能
 */
function initExplanationPanelDrag() {
    const panel = document.getElementById('explanationPanel');
    const header = document.getElementById('explanationPanelHeader');

    // 桌面版滑鼠拖曳
    header.addEventListener('mousedown', startExplanationPanelDrag);
    document.addEventListener('mousemove', dragExplanationPanel);
    document.addEventListener('mouseup', stopExplanationPanelDrag);

    // 手機版不啟用拖曳（全螢幕模式不需要）
    // 只在桌面版啟用觸控拖曳
    if (window.innerWidth > 768) {
        header.addEventListener('touchstart', startExplanationPanelDragTouch, { passive: false });
        document.addEventListener('touchmove', dragExplanationPanelTouch, { passive: false });
        document.addEventListener('touchend', stopExplanationPanelDrag);
    }
}

function startExplanationPanelDrag(e) {
    // 手機版不允許拖曳
    if (window.innerWidth <= 768) return;

    // 如果點擊的是關閉按鈕，不啟動拖曳
    if (e.target.closest('button')) return;

    const panel = document.getElementById('explanationPanel');
    explanationPanelDragging = true;
    explanationPanelOffsetX = e.clientX - panel.offsetLeft;
    explanationPanelOffsetY = e.clientY - panel.offsetTop;
    panel.style.transition = 'none';
}

function startExplanationPanelDragTouch(e) {
    // 手機版不允許拖曳
    if (window.innerWidth <= 768) return;

    // 如果點擊的是關閉按鈕，不啟動拖曳
    if (e.target.closest('button')) return;

    e.preventDefault();
    const touch = e.touches[0];
    const panel = document.getElementById('explanationPanel');
    explanationPanelDragging = true;
    explanationPanelOffsetX = touch.clientX - panel.offsetLeft;
    explanationPanelOffsetY = touch.clientY - panel.offsetTop;
    panel.style.transition = 'none';
}

function dragExplanationPanel(e) {
    if (!explanationPanelDragging) return;
    e.preventDefault();
    const panel = document.getElementById('explanationPanel');
    let newX = e.clientX - explanationPanelOffsetX;
    let newY = e.clientY - explanationPanelOffsetY;

    // 限制在視窗範圍內
    newX = Math.max(0, Math.min(newX, window.innerWidth - 320));
    newY = Math.max(0, Math.min(newY, window.innerHeight - 200));

    panel.style.left = newX + 'px';
    panel.style.top = newY + 'px';
}

function dragExplanationPanelTouch(e) {
    if (!explanationPanelDragging) return;
    e.preventDefault();
    const touch = e.touches[0];
    const panel = document.getElementById('explanationPanel');
    let newX = touch.clientX - explanationPanelOffsetX;
    let newY = touch.clientY - explanationPanelOffsetY;

    // 限制在視窗範圍內
    newX = Math.max(0, Math.min(newX, window.innerWidth - 320));
    newY = Math.max(0, Math.min(newY, window.innerHeight - 200));

    panel.style.left = newX + 'px';
    panel.style.top = newY + 'px';
}

function stopExplanationPanelDrag() {
    if (explanationPanelDragging) {
        const panel = document.getElementById('explanationPanel');
        panel.style.transition = '';
        explanationPanelDragging = false;
    }
}

/**
 * 開啟解析面板
 */
function toggleExplanationPanel() {
    if (isExplanationPanelOpen) {
        closeExplanationPanel();
    } else {
        openExplanationPanel();
    }
}

function openExplanationPanel() {
    const q = questions[currentIndex];
    if (!q.explanation) return;

    const panel = document.getElementById('explanationPanel');
    const content = document.getElementById('explanationContent');

    // 渲染 Markdown 解析
    content.innerHTML = marked.parse(q.explanation);
    document.getElementById('explanationQuestionNum').textContent = `第 ${q.number} 題`;

    panel.classList.remove('hidden');
    isExplanationPanelOpen = true;

    // ESC 鍵關閉
    document.addEventListener('keydown', closeExplanationPanelOnEsc);
}

function closeExplanationPanel() {
    const panel = document.getElementById('explanationPanel');
    panel.classList.add('hidden');
    isExplanationPanelOpen = false;
    document.removeEventListener('keydown', closeExplanationPanelOnEsc);
}

function closeExplanationPanelOnEsc(e) {
    if (e.key === 'Escape') {
        closeExplanationPanel();
    }
}

// ==================== 圖片 Dialog ====================
let imageZoom = 1;
let imageDragging = false;
let imageDragStartX = 0;
let imageDragStartY = 0;
let imageCurrentX = 0;
let imageCurrentY = 0;

function openImageDialog() {
    imageZoom = 1;
    imageCurrentX = 0;
    imageCurrentY = 0;
    document.getElementById('imageDialog').classList.remove('hidden');
}

function closeImageDialog() {
    document.getElementById('imageDialog').classList.add('hidden');
}

function handleDialogBackdropClick(event) {
    if (event.target.id === 'imageDialog') {
        closeImageDialog();
    }
}

function updateImageTransform(smooth = true) {
    const imageWrapper = document.getElementById('imageWrapper');
    if (smooth) {
        imageWrapper.style.transition = 'transform 0.3s ease';
    } else {
        imageWrapper.style.transition = 'none';
    }
    imageWrapper.style.transform = `scale(${imageZoom}) translate(${imageCurrentX}px, ${imageCurrentY}px)`;
}

function zoomIn() {
    imageZoom = Math.min(imageZoom + 0.2, 3);
    updateImageTransform();
}

function zoomOut() {
    imageZoom = Math.max(imageZoom - 0.2, 1);
    if (imageZoom === 1) {
        imageCurrentX = 0;
        imageCurrentY = 0;
    }
    updateImageTransform();
}

function resetZoom() {
    imageZoom = 1;
    imageCurrentX = 0;
    imageCurrentY = 0;
    updateImageTransform();
}

function handleWheel(event) {
    event.preventDefault();
    if (event.deltaY < 0) {
        zoomIn();
    } else {
        zoomOut();
    }
}

function startDrag(event) {
    if (imageZoom === 1) return;
    imageDragging = true;
    imageDragStartX = event.clientX;
    imageDragStartY = event.clientY;
}

function onDrag(event) {
    if (!imageDragging) return;
    const deltaX = (event.clientX - imageDragStartX) / imageZoom;
    const deltaY = (event.clientY - imageDragStartY) / imageZoom;
    imageCurrentX += deltaX;
    imageCurrentY += deltaY;
    imageDragStartX = event.clientX;
    imageDragStartY = event.clientY;
    updateImageTransform(false);
}

function endDrag() {
    imageDragging = false;
}

// ==================== 設定 Dialog ====================
function openSettingsDialog() {
    const input = document.getElementById('groqApiKeyInput');
    if (groqApiKey) {
        input.value = groqApiKey;
    }
    document.getElementById('settingsDialog').classList.remove('hidden');
    document.getElementById('modelSelectContainer').classList.add('hidden');
    document.getElementById('advancedSettingsContainer').classList.add('hidden');
}

function closeSettingsDialog() {
    document.getElementById('settingsDialog').classList.add('hidden');
}

function handleSettingsBackdropClick(event) {
    if (event.target.id === 'settingsDialog') {
        closeSettingsDialog();
    }
}

async function verifyApiKey() {
    const input = document.getElementById('groqApiKeyInput');
    const key = input.value.trim();

    if (!key) {
        alert('請輸入 GROQ API Key');
        return;
    }

    const btn = document.getElementById('verifyApiKeyBtn');
    const spinner = document.getElementById('verifySpinner');
    const status = document.getElementById('apiKeyStatus');

    btn.disabled = true;
    spinner.classList.remove('hidden');

    try {
        // 測試 API Key
        const response = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        if (response.ok) {
            const data = await response.json();
            availableModels = data.data.map(m => m.id);
            groqApiKey = key;
            localStorage.setItem('groq_api_key', key);

            // 顯示模型選擇
            document.getElementById('modelSelectContainer').classList.remove('hidden');
            document.getElementById('advancedSettingsContainer').classList.remove('hidden');
            status.textContent = '✓ API Key 驗證成功';
            status.className = 'mt-2 text-xs text-green-400';

            // 填充模型列表
            populateModelDropdown();
        } else {
            status.textContent = '✗ API Key 無效';
            status.className = 'mt-2 text-xs text-red-400';
        }
    } catch (e) {
        status.textContent = '✗ 無法連接到 GROQ API';
        status.className = 'mt-2 text-xs text-red-400';
    }

    spinner.classList.add('hidden');
    btn.disabled = false;
}

function populateModelDropdown() {
    const dropdown = document.getElementById('modelDropdown');
    dropdown.innerHTML = availableModels
        .filter(m => m.includes('mixtral') || m.includes('gpt') || m.includes('llama'))
        .map(m => `<div class="px-4 py-2 hover:bg-slate-700 cursor-pointer text-sm" onclick="selectModel('${m}')">${m}</div>`)
        .join('');
}

function selectModel(modelId) {
    groqModel = modelId;
    document.getElementById('currentModelName').textContent = modelId;
    document.getElementById('modelSearchInput').value = '';
    document.getElementById('modelDropdown').classList.add('hidden');
}

function showModelDropdown() {
    const dropdown = document.getElementById('modelDropdown');
    dropdown.classList.toggle('hidden');
}

function filterModels() {
    const input = document.getElementById('modelSearchInput').value.toLowerCase();
    const dropdown = document.getElementById('modelDropdown');

    const filtered = availableModels.filter(m => m.toLowerCase().includes(input));
    dropdown.innerHTML = filtered.map(m =>
        `<div class="px-4 py-2 hover:bg-slate-700 cursor-pointer text-sm" onclick="selectModel('${m}')">${m}</div>`
    ).join('');
}

function toggleAdvancedSettings() {
    const content = document.getElementById('advancedSettingsContent');
    const icon = document.getElementById('advancedSettingsIcon');
    const isHidden = content.classList.contains('hidden');

    if (isHidden) {
        content.classList.remove('hidden');
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.classList.add('hidden');
        icon.style.transform = 'rotate(0deg)';
    }
}

function loadSystemPrompt() {
    document.getElementById('customPromptInput').value = AI_SYSTEM_PROMPT;
}

function resetCustomPrompt() {
    document.getElementById('customPromptInput').value = '';
}

function saveSettings() {
    if (!groqApiKey) {
        alert('請先輸入並驗證 API Key');
        return;
    }

    let customPrompt = document.getElementById('customPromptInput').value.trim();

    // 如果內容等於系統預設提示詞，儲存為空（表示使用系統預設）
    if (customPrompt === AI_SYSTEM_PROMPT.trim()) {
        customPrompt = '';
    }

    localStorage.setItem('groq_api_key', groqApiKey);
    localStorage.setItem('groq_model', groqModel);
    localStorage.setItem('groq_custom_prompt', customPrompt);

    closeSettingsDialog();
}

// ==================== 進階設定 Dialog ====================
function openAdvancedSettingsDialog() {
    document.getElementById('advancedSettingsDialog').classList.remove('hidden');

    // 載入已保存的設定
    document.getElementById('rangeEnabledCheckbox').checked = rangeEnabled;
    document.getElementById('showImportantOnlyCheckbox').checked = showImportantOnly;
    document.getElementById('randomJumpCheckbox').checked = randomJumpEnabled;
    document.getElementById('keywordHighlightCheckbox').checked = keywordHighlightEnabled;

    if (rangeEnabled) {
        document.getElementById('rangeInputContainer').classList.remove('hidden');
        document.getElementById('rangeStartInput').value = rangeStart;
        document.getElementById('rangeEndInput').value = rangeEnd || '';
        updateRangeInfo();
    }

    if (showImportantOnly) {
        document.getElementById('showImportantOnlyInfo').classList.remove('hidden');
        updateImportantOnlyInfo();
    }

    if (randomJumpEnabled) {
        document.getElementById('randomJumpInfo').classList.remove('hidden');
    }

    // 初始化題型過濾設定
    updateQuestionTypeCheckboxes();
    updateTypeFilterInfo();
}

function closeAdvancedSettingsDialog() {
    document.getElementById('advancedSettingsDialog').classList.add('hidden');
}

function handleAdvancedSettingsBackdropClick(event) {
    if (event.target.id === 'advancedSettingsDialog') {
        closeAdvancedSettingsDialog();
    }
}

function toggleRangeEnabled() {
    rangeEnabled = document.getElementById('rangeEnabledCheckbox').checked;
    const container = document.getElementById('rangeInputContainer');

    if (rangeEnabled) {
        container.classList.remove('hidden');
    } else {
        container.classList.add('hidden');
    }

    localStorage.setItem('range_enabled', rangeEnabled);
    updateJumpInputMax();

    // 如果僅顯示重要題目已啟用，更新其信息
    if (showImportantOnly) {
        updateImportantOnlyInfo();
    }
}

function toggleRandomJump() {
    randomJumpEnabled = document.getElementById('randomJumpCheckbox').checked;
    const info = document.getElementById('randomJumpInfo');

    if (randomJumpEnabled) {
        info.classList.remove('hidden');
    } else {
        info.classList.add('hidden');
    }

    localStorage.setItem('random_jump_enabled', randomJumpEnabled);
}

function toggleKeywordHighlight() {
    keywordHighlightEnabled = document.getElementById('keywordHighlightCheckbox').checked;
    localStorage.setItem('keyword_highlight_enabled', keywordHighlightEnabled);

    // 重新渲染題目以套用新的設定
    if (questions.length > 0) {
        renderQuestion();
    }
}

function toggleQuestionType(type) {
    const index = enabledQuestionTypes.indexOf(type);

    // 邊界檢查：至少保留一個題型
    if (index !== -1 && enabledQuestionTypes.length === 1) {
        alert('至少需要選擇一種題型');
        updateQuestionTypeCheckboxes();
        return;
    }

    // 切換題型啟用狀態
    if (index !== -1) {
        enabledQuestionTypes.splice(index, 1);
    } else {
        enabledQuestionTypes.push(type);
    }

    // 保存到 localStorage
    localStorage.setItem('enabled_question_types', JSON.stringify(enabledQuestionTypes));

    // 更新信息顯示
    updateTypeFilterInfo();
    updateQuestionTypeCheckboxes();

    // 如果當前題目被過濾，跳轉到第一個有效題目
    if (questions.length > 0) {
        const validIndices = getValidIndices();
        if (validIndices.length === 0 || !validIndices.includes(currentIndex)) {
            if (validIndices.length > 0) {
                currentIndex = validIndices[0];
                renderQuestion();
            }
        }
    }
}

function updateTypeFilterInfo() {
    const typeFilterInfoText = document.getElementById('typeFilterInfoText');
    if (!typeFilterInfoText) return;

    const validIndices = getValidIndices();
    const typeNames = enabledQuestionTypes.join('、');

    if (validIndices.length === 0) {
        typeFilterInfoText.textContent = `已選題型：${typeNames}（無符合的題目）`;
    } else {
        typeFilterInfoText.textContent = `已選題型：${typeNames}（${validIndices.length} 題）`;
    }
}

function updateQuestionTypeCheckboxes() {
    const singleChoiceCheckbox = document.getElementById('singleChoiceCheckbox');
    const multipleChoiceCheckbox = document.getElementById('multipleChoiceCheckbox');
    const shortAnswerCheckbox = document.getElementById('shortAnswerCheckbox');

    if (singleChoiceCheckbox) singleChoiceCheckbox.checked = enabledQuestionTypes.includes('單選題');
    if (multipleChoiceCheckbox) multipleChoiceCheckbox.checked = enabledQuestionTypes.includes('多選題');
    if (shortAnswerCheckbox) shortAnswerCheckbox.checked = enabledQuestionTypes.includes('簡答題');
}

function toggleShowImportantOnly() {
    showImportantOnly = document.getElementById('showImportantOnlyCheckbox').checked;
    const info = document.getElementById('showImportantOnlyInfo');

    if (showImportantOnly) {
        info.classList.remove('hidden');
        // 更新信息顯示
        updateImportantOnlyInfo();
    } else {
        info.classList.add('hidden');
    }

    localStorage.setItem('show_important_only', showImportantOnly);

    // 如果當前題目不在有效範圍內，跳到第一個有效題目
    if (questions.length > 0) {
        const validIndices = getValidIndices();
        if (validIndices.length > 0 && !validIndices.includes(currentIndex)) {
            currentIndex = validIndices[0];
            renderQuestion();
        }
    }
}

/**
 * 更新僅顯示重要題目的信息文字
 */
function updateImportantOnlyInfo() {
    const infoText = document.getElementById('importantOnlyInfoText');
    if (!infoText || questions.length === 0) return;

    const validIndices = getValidIndices();
    const importantCount = validIndices.length;

    if (rangeEnabled) {
        const range = getValidRange();
        infoText.textContent = `範圍內共 ${importantCount} 題重要題目（第 ${range.startNum} ~ ${range.endNum} 題）`;
    } else {
        infoText.textContent = `共 ${importantCount} 題重要題目`;
    }
}

function updateRangeSettings() {
    const startInput = document.getElementById('rangeStartInput');
    const endInput = document.getElementById('rangeEndInput');

    rangeStart = parseInt(startInput.value) || 1;
    rangeEnd = endInput.value ? parseInt(endInput.value) : null;

    localStorage.setItem('range_start', rangeStart);
    localStorage.setItem('range_end', rangeEnd || '');

    updateRangeInfo();
    updateJumpInputMax();

    // 如果僅顯示重要題目已啟用，更新其信息
    if (showImportantOnly) {
        updateImportantOnlyInfo();
    }
}

function updateRangeInfo() {
    const range = getValidRange();
    document.getElementById('rangeInfoText').textContent =
        `目前範圍：第 ${range.startNum} 題 ~ 第 ${range.endNum} 題（共 ${range.endIdx - range.startIdx + 1} 題）`;
}

function resetRange() {
    rangeEnabled = false;
    rangeStart = 1;
    rangeEnd = null;
    document.getElementById('rangeEnabledCheckbox').checked = false;
    document.getElementById('rangeInputContainer').classList.add('hidden');
    localStorage.setItem('range_enabled', 'false');
    localStorage.removeItem('range_start');
    localStorage.removeItem('range_end');
    updateJumpInputMax();
}

// ==================== 手機版互動功能 ====================

/**
 * 開啟手機版選單
 */
function openMobileMenu() {
    const panel = document.getElementById('mobileMenuPanel');
    if (panel) {
        panel.classList.add('open');
        document.body.style.overflow = 'hidden';
    }
}

/**
 * 關閉手機版選單
 */
function closeMobileMenu() {
    const panel = document.getElementById('mobileMenuPanel');
    if (panel) {
        panel.classList.remove('open');
        document.body.style.overflow = '';
    }
}

/**
 * 切換統計面板顯示（手機版）
 */
function toggleStatsPanel() {
    const panel = document.getElementById('statsPanel');
    const toggleBtn = document.getElementById('statsToggleBtn');
    const toggleIcon = document.getElementById('statsToggleIcon');

    if (panel && toggleBtn) {
        const isOpen = panel.classList.contains('open');

        if (isOpen) {
            panel.classList.remove('open');
            toggleBtn.classList.remove('open');
            // 恢復統計圖示
            if (toggleIcon) {
                toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>';
            }
        } else {
            panel.classList.add('open');
            toggleBtn.classList.add('open');
            // 變成關閉圖示
            if (toggleIcon) {
                toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>';
            }
        }
    }
}

/**
 * 檢測是否為手機裝置
 */
function isMobile() {
    return window.innerWidth <= 1024;
}

/**
 * 處理視窗大小變化
 */
function handleResize() {
    const statsPanel = document.getElementById('statsPanel');
    const statsToggleBtn = document.getElementById('statsToggleBtn');

    if (isMobile()) {
        // 手機版：確保面板初始為關閉
        if (statsToggleBtn) statsToggleBtn.style.display = 'flex';
    } else {
        // 桌面版：確保面板正常顯示
        if (statsPanel) statsPanel.classList.remove('open');
        if (statsToggleBtn) {
            statsToggleBtn.style.display = 'none';
            statsToggleBtn.classList.remove('open');
        }
    }
}

// ==================== 鍵盤快捷鍵 ====================
document.addEventListener('keydown', (e) => {
    if (!questions || questions.length === 0) return;

    // 方向鍵導航
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        nextQuestion();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        prevQuestion();
    }
});

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    // 載入已儲存的 GROQ 設定
    const savedKey = localStorage.getItem('groq_api_key');
    const savedModel = localStorage.getItem('groq_model');
    if (savedKey) groqApiKey = savedKey;
    if (savedModel) groqModel = savedModel;

    // 載入已儲存的進階設定
    const savedRandomJump = localStorage.getItem('random_jump_enabled');
    randomJumpEnabled = savedRandomJump === 'true';

    // 載入關鍵字高亮設定（預設為啟用）
    const savedKeywordHighlight = localStorage.getItem('keyword_highlight_enabled');
    keywordHighlightEnabled = savedKeywordHighlight !== 'false'; // 預設 true，只有明確設為 false 才停用

    // 載入閱讀範圍設定
    const savedRangeEnabled = localStorage.getItem('range_enabled');
    const savedRangeStart = localStorage.getItem('range_start');
    const savedRangeEnd = localStorage.getItem('range_end');
    rangeEnabled = savedRangeEnabled === 'true';
    rangeStart = savedRangeStart ? parseInt(savedRangeStart) : 1;
    rangeEnd = savedRangeEnd ? parseInt(savedRangeEnd) : null;

    // 載入僅顯示重要題目設定
    const savedShowImportantOnly = localStorage.getItem('show_important_only');
    showImportantOnly = savedShowImportantOnly === 'true';

    // 載入題型過濾設定
    const savedQuestionTypes = localStorage.getItem('enabled_question_types');
    if (savedQuestionTypes) {
        try {
            enabledQuestionTypes = JSON.parse(savedQuestionTypes);
            if (!Array.isArray(enabledQuestionTypes) || enabledQuestionTypes.length === 0) {
                enabledQuestionTypes = ['單選題', '多選題', '簡答題'];
            }
        } catch (e) {
            enabledQuestionTypes = ['單選題', '多選題', '簡答題'];
        }
    }

    // 初始化懸浮解析視窗拖曳功能
    initExplanationPanelDrag();

    // 初始化手機版功能
    handleResize();
    window.addEventListener('resize', handleResize);

    // 點擊手機選單外部關閉選單
    document.getElementById('mobileMenuPanel')?.addEventListener('click', (e) => {
        if (e.target.id === 'mobileMenuPanel') {
            closeMobileMenu();
        }
    });

    // ESC 鍵快捷功能
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // 優先關閉已開啟的面板
            const mobileMenuPanel = document.getElementById('mobileMenuPanel');
            const statsPanel = document.getElementById('statsPanel');

            // 如果手機選單打開，關閉它
            if (mobileMenuPanel?.classList.contains('open')) {
                closeMobileMenu();
                return;
            }

            // 如果統計面板打開，關閉它
            if (statsPanel?.classList.contains('open')) {
                toggleStatsPanel();
                return;
            }

            // 如果解析面板打開，由 closeExplanationPanelOnEsc 處理
            if (isExplanationPanelOpen) {
                return;
            }

            // 沒有面板打開時，聚焦到跳題輸入框並清空
            const jumpInput = document.getElementById('jumpInput');
            if (jumpInput && questions.length > 0) {
                jumpInput.value = '';
                jumpInput.focus();
                jumpInput.select();
            }
        }
    });

    autoLoadQuestions();
});

// ==================== AI 解析功能 ====================
const AI_SYSTEM_PROMPT = `你是一個具備專業知識的考題解析專家，專門用於題庫練習與學習知識輔助。

你的任務是：
1. 仔細閱讀「題目內容」與「所有選項」
2. 僅根據題目條件與邏輯推論作答，不可憑空猜測
3. 明確選出一個最正確的答案
4. 提供清楚、結構化、可學習的解析說明
5. 全程使用「繁體中文」回覆

請嚴格依照以下輸出格式回答（不得省略段落標題）：

--------------------------------
正確答案：<請填入選項代號，例如 A / B / C / D>

解析：
<說明為何該選項符合題目條件，需具備邏輯推導與關鍵判斷依據>

題目條件關鍵：
1. <從題目中萃取的關鍵條件或限制>
2. <重要的技術名詞、規則、前提或情境>
（如有更多關鍵條件可自行補充）

各選項比較：
A. <選項內容簡述與判斷原因> ❌ / ✅
B. <選項內容簡述與判斷原因> ❌ / ✅
C. <選項內容簡述與判斷原因> ❌ / ✅
D. <選項內容簡述與判斷原因> ❌ / ✅

結論：
<總結分析，說明為何正確答案在所有選項中是最佳且最符合題意的選擇>
--------------------------------

補充規則：
- 若題目為單選題，只能有一個「正確答案」
- 若題目為多選題，需列出所有正確選項
- 若題目描述不足或有歧義，請以「最符合一般考試標準解釋」進行判斷
- 各選項說明請保持簡短、精準、可比較
- 不要加入與題目無關的延伸知識`;

/**
 * 使用 AI 分析當前題目
 */
async function analyzeWithAI() {
    // 檢查 API Key
    if (!groqApiKey) {
        const savedKey = localStorage.getItem('groq_api_key');
        if (savedKey) {
            groqApiKey = savedKey;
        } else {
            alert('請先在設定中配置 GROQ API Key');
            openSettingsDialog();
            return;
        }
    }

    // 載入已儲存的模型和自訂提示詞
    const savedModel = localStorage.getItem('groq_model');
    const savedPrompt = localStorage.getItem('groq_custom_prompt');
    if (savedModel) {
        groqModel = savedModel;
    }

    // 決定使用的提示詞
    let systemPrompt = AI_SYSTEM_PROMPT;
    if (savedPrompt && savedPrompt.trim() && savedPrompt.trim() !== '請使用系統原生提示詞') {
        systemPrompt = savedPrompt.trim();
    }

    // 取得當前題目
    const q = questions[currentIndex];
    if (!q) return;

    // 顯示區塊並設定載入狀態
    const section = document.getElementById('aiAnalysisSection');
    const loading = document.getElementById('aiAnalysisLoading');
    const content = document.getElementById('aiAnalysisContent');
    const error = document.getElementById('aiAnalysisError');

    section.classList.remove('hidden');
    loading.classList.remove('hidden');
    content.classList.add('hidden');
    error.classList.add('hidden');

    // 滾動到 AI 解析區塊
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // 組合題目內容（根據題型調整格式）
    let userPrompt = `題目類型：${q.type}

題目：
${q.englishText}

${q.chineseText ? `中文翻譯：\n${q.chineseText}\n` : ''}`;

    if (q.isShortAnswer) {
        // 簡答題格式
        userPrompt += `\n這是一道簡答題，請協助分析題目並提供詳細的解答思路。`;
        if (q.shortAnswer) {
            userPrompt += `\n\n參考答案：\n${q.shortAnswer}`;
        }
    } else {
        // 選擇題格式
        const optionsText = q.options.map(opt => `${opt.letter}. ${opt.text}`).join('\n');
        userPrompt += `選項：\n${optionsText}`;
    }

    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${groqApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: groqModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.3,
                max_tokens: 2048
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `API 請求失敗 (${response.status})`);
        }

        const data = await response.json();
        const result = data.choices[0]?.message?.content || '無法取得回應';

        // 顯示結果
        loading.classList.add('hidden');
        content.classList.remove('hidden');
        content.innerHTML = formatAiResponse(result);

    } catch (err) {
        console.error('AI 分析錯誤:', err);
        loading.classList.add('hidden');
        error.classList.remove('hidden');
        document.getElementById('aiAnalysisErrorMsg').textContent = err.message;
    }
}

/**
 * 隱藏 AI 解析區塊
 */
function hideAiAnalysis() {
    document.getElementById('aiAnalysisSection').classList.add('hidden');
}

/**
 * 格式化 AI 回應（簡易 Markdown 轉 HTML）
 */
function formatAiResponse(text) {
    // 移除開頭的分隔線
    let processed = text.replace(/^-{3,}\s*\n?/gm, '').trim();

    // 先轉義 HTML
    processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // 按行處理
    const lines = processed.split('\n');
    const result = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 跳過空行和分隔線
        if (!line || /^-{3,}$/.test(line)) {
            if (line && result.length > 0) {
                result.push('<div class="h-2"></div>');
            }
            continue;
        }

        // 正確答案（優先匹配）
        if (/^正確答案[：:]/.test(line)) {
            const match = line.match(/正確答案[：:]\s*(.+)/);
            if (match) {
                result.push(`<div class="bg-green-500/10 border-l-4 border-green-500 px-4 py-3 rounded-r-lg mb-4"><div class="text-lg font-bold text-green-400 mb-1">✓ 正確答案</div><div class="text-2xl font-bold text-green-300 tracking-wider">${match[1]}</div></div>`);
            }
            continue;
        }

        // 段落標題
        if (/^(解析|題目條件關鍵|各選項比較|結論)[：:]/.test(line)) {
            const match = line.match(/^(解析|題目條件關鍵|各選項比較|結論)[：:]/);
            if (match) {
                result.push(`<div class="mt-6 mb-3 first:mt-0"><h4 class="text-lg font-bold text-blue-400 flex items-center gap-2"><span class="w-1 h-5 bg-blue-400 rounded"></span>${match[1]}</h4></div>`);
            }
            continue;
        }

        // 選項行（帶 ✅ 或 ❌）
        const optionMatch = line.match(/^([A-F])\.\s+(.+?)(✅|❌)$/);
        if (optionMatch) {
            const [, letter, content, emoji] = optionMatch;
            const isCorrect = emoji === '✅';
            const bgClass = isCorrect ? 'bg-green-500/10 border-green-500/30' : 'bg-slate-800/50 border-slate-700/50';
            const textClass = isCorrect ? 'text-green-300' : 'text-gray-400';
            const letterClass = isCorrect ? 'text-green-400' : 'text-slate-500';
            result.push(`<div class="ml-4 my-2.5 p-3 rounded-lg border ${bgClass} flex items-start gap-3"><span class="font-bold ${letterClass} text-lg shrink-0">${letter}.</span><span class="flex-1 ${textClass} leading-relaxed">${content}</span><span class="text-xl shrink-0">${emoji}</span></div>`);
            continue;
        }

        // 列表項
        const listMatch = line.match(/^(\d+)\.\s+(.+)$/);
        if (listMatch) {
            result.push(`<div class="ml-6 my-2 flex items-start gap-2"><span class="text-blue-400 font-semibold shrink-0">${listMatch[1]}.</span><span class="text-gray-300 leading-relaxed">${listMatch[2]}</span></div>`);
            continue;
        }

        // 一般文字（處理粗體）
        let formattedLine = line.replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');

        // 如果前一行不是特殊格式，添加適當的間距和樣式
        if (result.length > 0 && !result[result.length - 1].includes('class="mt-6') && !result[result.length - 1].includes('class="bg-')) {
            formattedLine = `<div class="mb-2.5 text-gray-300 leading-relaxed text-base">${formattedLine}</div>`;
        } else {
            formattedLine = `<div class="text-gray-300 leading-relaxed text-base">${formattedLine}</div>`;
        }

        result.push(formattedLine);
    }

    return result.join('');
}
