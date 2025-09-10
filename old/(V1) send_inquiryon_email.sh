#!/bin/bash

# Inquiryon Lab Email Sender Script
# Usage: ./send_inquiryon_email.sh [options]

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HTML_FILE="inquiryon_lab_invitation.html"
TITLE="Inquiryon Lab: AI Agents with Human-in-the-Loop"
EMAIL_SUBJECT="$TITLE - Brown Bag Session (8/22)"
SENDER_EMAIL="edwardgem@gmail.com"
SENDER_NAME="Edward Cheng, Inquiryon"
LOG_FILE="/dev/null"  # No logging by default; $SCRIPT_DIR/logs/inquiryon_email.log

# Recipient list - Update these email addresses as needed
RECIPIENTS=(
    "jeshua.cheng@inquiryon.com",
    "lampatrick2006@yahoo.com",
    "kenny.ching@gmail.com",
    "bunnydoctor@gmail.com",
    "enochyang1228@gmail.com",
    "eddie.lo@gmail.com",
    "yong.andrew11@gmail.com",
    "ccyee@yahoo.com"

    # Add more recipients here
)

# Function to display usage
show_help() {
    cat << EOF
Inquiryon Lab Email Sender Script

Usage: $0 [OPTIONS]

OPTIONS:
    -g, --generate-only     Generate HTML file only (no email sending)
    -s, --send [file]       Send email using specified HTML file
    -f, --file <filename>   Specify custom HTML filename (default: $DEFAULT_HTML_FILE)
    -h, --help              Show this help message

EXAMPLES:
    $0 -g                   Generate HTML file for review
    $0 -s                   Generate and send email
    $0 -s custom.html       Send using custom HTML file
    $0 -f my_email.html -g  Generate with custom filename

NOTE: 
    - Update recipient list in the script before sending
    - Ensure you have Claude MCP server access for Gmail
    - The script will prompt for confirmation before sending
EOF
}

# Function to generate HTML content
generate_html() {
    local output_file="$1"
    
    cat > "$output_file" << 'EOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Inquiryon Lab - AI Agents with Human-in-the-Loop</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f5f7fa;
        }
        .email-container {
            max-width: 600px;
            margin: 20px auto;
            background-color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #a0a0a0 0%, #111111 100%);
            color: white;
            padding: 30px;
            text-align: center;
            position: relative;
        }
        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="0.5"/></pattern></defs><rect width="100" height="100" fill="url(%23grid)"/></svg>') repeat;
        }
        .logo-section {
            position: relative;
            z-index: 2;
            margin-bottom: 0px;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }
        .logo-placeholder {
            width: 120px;
            height: 40px;
            background-color: rgba(255, 255, 255, 0.2);
            border: 2px dashed rgba(255, 255, 255, 0.5);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.8);
        }
        .company-name {
            font-size: 24px;
            font-weight: bold;
            margin: 10px 0 5px 0;
            position: relative;
            z-index: 2;
        }
        .lab-subtitle {
            font-size: 14px;
            opacity: 0.9;
            position: relative;
            z-index: 2;
        }
        .content {
            padding: 40px 30px;
        }
        .event-title {
            font-size: 28px;
            font-weight: bold;
            color: #2c3e50;
            text-align: center;
            margin-bottom: 30px;
            line-height: 1.3;
        }
        .event-details {
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            border-left: 5px solid #667eea;
        }
        .detail-row {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
            font-size: 16px;
        }
        .detail-row:last-child {
            margin-bottom: 0;
        }
        .detail-icon {
            width: 24px;
            height: 24px;
            margin-right: 15px;
            flex-shrink: 0;
        }
        .detail-label {
            font-weight: bold;
            color: #495057;
            min-width: 80px;
        }
        .detail-value {
            color: #2c3e50;
        }
        .intro-text {
            font-size: 16px;
            margin-bottom: 25px;
            color: #495057;
        }
        .key-points {
            background-color: #fff5f5;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            border-left: 5px solid #e53e3e;
        }
        .key-points h3 {
            color: #c53030;
            margin-top: 0;
            margin-bottom: 15px;
            font-size: 18px;
            display: flex;
            align-items: center;
        }
        .key-points ul {
            margin: 0;
            padding-left: 20px;
        }
        .key-points li {
            margin-bottom: 10px;
            color: #2d3748;
        }
        .discussion-topics {
            background-color: #f0fff4;
            border-radius: 12px;
            padding: 25px;
            margin-bottom: 30px;
            border-left: 5px solid #38a169;
        }
        .discussion-topics h3 {
            color: #2f855a;
            margin-top: 0;
            margin-bottom: 15px;
            font-size: 18px;
        }
        .discussion-topics ul {
            margin: 0;
            padding-left: 20px;
        }
        .discussion-topics li {
            margin-bottom: 10px;
            color: #2d3748;
        }
        .cta-section {
            background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%);
            color: white;
            padding: 25px;
            border-radius: 12px;
            text-align: center;
            margin-bottom: 20px;
        }
        .cta-text {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 15px;
        }
        .cta-subtext {
            font-size: 14px;
            opacity: 0.9;
        }
        .footer {
            background-color: #f8f9fa;
            padding: 20px 30px;
            text-align: center;
            color: #6c757d;
            font-size: 14px;
        }
        .ai-icon {
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="2" y="8" width="20" height="8" rx="2"/><path d="m6 8 4-4 4 4"/><path d="m6 16 4 4 4-4"/></svg>') no-repeat center;
            background-size: contain;
        }
        .warning-icon {
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="m12 17.02.01 0"/></svg>') no-repeat center;
            background-size: contain;
        }
        @media (max-width: 600px) {
            .email-container {
                margin: 10px;
                border-radius: 8px;
            }
            .header {
                padding: 20px;
            }
            .content {
                padding: 20px;
            }
            .event-title {
                font-size: 24px;
            }
            .detail-row {
                flex-direction: column;
                align-items: flex-start;
                text-align: left;
            }
            .detail-icon {
                margin-bottom: 5px;
            }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <div class="logo-section">
                <img src="https://www.inquiryon.com/logo.png" height="45px" alt="Inquiryon Logo" />
                <span style="font-size: 25px;">Inquiryon</span>
            </div>
            <!--div class="company-name">Inquiryon AI</div>
            <div class="lab-subtitle">Inquiryon Lab</div-->
        </div>
        
        <div class="content">
            <h1 class="event-title">🤖 Brown Bag AI Presentation<br><br>
                <span style="color: #000090; font-size: 25px;">Safe AI Agents with Human-in-the-Loop</span></h1>
            
            <div class="event-details">
                <div class="detail-row">
                    <svg class="detail-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                    <span class="detail-label">Date:</span>
                    <span class="detail-value">August 22 (Friday)</span>
                </div>
                <div class="detail-row">
                    <svg class="detail-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                    </svg>
                    <span class="detail-label">Time:</span>
                    <span class="detail-value">11:00 AM - 12:00 PM</span>
                </div>
                <div class="detail-row">
                    <svg class="detail-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                    </svg>
                    <span class="detail-label">Speaker:</span>
                    <span class="detail-value">Jeshua Cheng, Founder of Inquiryon</span>
                </div>
                <div class="detail-row">
                    <svg class="detail-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 002 2v8a2 2 0 002 2z"/>
                    </svg>
                    <span class="detail-label">Venue:</span>
                    <span class="detail-value"><a href="https://meet.google.com/nuk-nbbo-ptn" style="color: #667eea; text-decoration: none;">Google Meet</a></span>
                </div>
            </div>
            
            <p class="intro-text">
                Join us for an engaging discussion on the future of AI safety! As AI agents become increasingly powerful and autonomous, ensuring their safe deployment becomes critical for businesses and society.
            </p>
            
            <div class="key-points">
                <h3>
                    <svg style="width: 20px; height: 20px; margin-right: 8px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.728-.833-2.498 0L4.316 18.5c-.77.833.192 2.5 1.732 2.5z"/>
                    </svg>
                    Critical Challenge
                </h3>
                <ul>
                    <li><strong>67% of CEOs</strong> identify AI agent errors as their top concern.</li>
                    <li>AI agents, capable of reasoning, planning, and proactively executing actions, are redefining how work gets done.</li>
                    <li>The need for safe AI deployment has never been more urgent.</li>
                </ul>
            </div>
            
            <div class="discussion-topics">
                <h3>
                    <svg style="width: 20px; height: 20px; margin-right: 8px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                    </svg>
                    What We'll Discuss
                </h3>
                <ul>
                    <li>The powerful capabilities of modern AI agents.</li>
                    <li>MCP (Model Context Protocol) and agent tools.</li>
                    <li>Our innovative solution: Human-in-the-Loop (HITL) for Safe AI agents.</li>
                </ul>
            </div>
            
            <div class="cta-section">
                <div class="cta-text">Ready to Join the Conversation?</div>
                <div class="cta-subtext">
                    RSVP: Please Reply to let us know if you plan to attend.<br>
                    Feel free to forward this invitation to anyone who might be interested!
                </div>
            </div>
        </div>
        
        <div class="footer">
            <p><strong>Inquiryon Lab</strong> - Developing Safe AI Technologies</p>
            <p>Contact: Edward Cheng | <a href="mailto:edwardgem@gmail.com" style="color: #667eea;">edwardgem@gmail.com</a></p>
            <p><a href="https://inquiryon.com" style="color: #667eea;">inquiryon.com</a></p>
        </div>
    </div>
</body>
</html>
EOF

    echo "✅ HTML file generated: $output_file"
}

# Function to send email via Claude MCP
send_email() {
    local html_file="$1"
    
    if [[ ! -f "$html_file" ]]; then
        echo "❌ Error: HTML file '$html_file' not found!"
        exit 1
    fi
    
    echo "📧 Preparing to send email..."
    echo "Subject: $EMAIL_SUBJECT"
    echo "From: $SENDER_NAME"
    echo "To: $SENDER_EMAIL (sender)"
    echo "BCC Recipients: ${#RECIPIENTS[@]} addresses"
    echo
    
    # Show recipient list
    echo "📋 BCC Recipient List:"
    for i in "${!RECIPIENTS[@]}"; do
        echo "  $((i+1)). ${RECIPIENTS[i]}"
    done
    echo
    
    # Confirmation prompt
    read -p "⚠️  Do you want to send this email to all BCC recipients? (y/N): " confirm
    
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "❌ Email sending cancelled."
        exit 0
    fi
    
    # Read HTML content
    html_content=$(cat "$html_file")
    
    # Convert recipients array to comma-separated string for BCC
    bcc_list=$(IFS=','; echo "${RECIPIENTS[*]}")
    
    echo "🚀 Sending email with BCC recipients..."
    echo "  📤 To: $SENDER_EMAIL"
    echo "  📤 BCC: ${#RECIPIENTS[@]} recipients (hidden)"
    
    # Send email using Claude MCP Gmail integration
    echo "📡 Calling Gmail MCP service..."
    
    # Create a temporary file for the MCP call
    temp_json=$(mktemp)
    cat > "$temp_json" << EOF
{
    "to": ["$SENDER_EMAIL"],
    "bcc": [$(printf '"%s",' "${RECIPIENTS[@]}" | sed 's/,$//')],
    "subject": "$EMAIL_SUBJECT",
    "htmlBody": $(echo "$html_content" | jq -Rs .),
    "mimeType": "text/html"
}
EOF
    
    # Execute the MCP call
    if command -v claude >/dev/null 2>&1; then
        echo "  🔄 Sending via Claude MCP..."
        # calling claude server-gmail-autoauth-mcp:send_email
        if claude "send email $(cat "$temp_json")" 2>$LOG_FILE; then
            echo "  ✅ Email sent successfully!"
        else
            echo "  ❌ Error: MCP call failed. Please check authentication."
            echo "  💡 Make sure you're authenticated with Gmail via Claude MCP"
            rm -f "$temp_json"
            exit 1
        fi
    else
        echo "  ❌ Error: Claude CLI not found"
        echo "  💡 Please install Claude CLI or run this manually:"
        echo "  📋 MCP Command:"
        echo "      claude mcp server-gmail-autoauth-mcp:send_email '$(cat "$temp_json")'"
        echo
        echo "  📋 Or use these parameters directly:"
        echo "      To: $SENDER_EMAIL"
        echo "      BCC: $bcc_list"
        echo "      Subject: $EMAIL_SUBJECT"
        echo "      HTML Body: [content from $html_file]"
    fi
    
    # Clean up
    rm -f "$temp_json"
    
    echo "✅ Email sending process completed!"
    echo "📊 Summary: 1 email sent with ${#RECIPIENTS[@]} BCC recipients"
    echo "🔒 Privacy: Recipient emails are hidden from each other"
}

# Function to validate recipients
validate_recipients() {
    local invalid_emails=()
    
    for email in "${RECIPIENTS[@]}"; do
        if [[ ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
            invalid_emails+=("$email")
        fi
    done
    
    if [[ ${#invalid_emails[@]} -gt 0 ]]; then
        echo "⚠️  Warning: Invalid email addresses found:"
        for email in "${invalid_emails[@]}"; do
            echo "  - $email"
        done
        echo
        read -p "Continue anyway? (y/N): " confirm
        if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
}

# Main script logic
main() {
    local generate_only=false
    local send_email_flag=false
    local html_file="$DEFAULT_HTML_FILE"
    local custom_file=""
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -g|--generate-only)
                generate_only=true
                shift
                ;;
            -s|--send)
                send_email_flag=true
                if [[ -n "$2" && ! "$2" =~ ^- ]]; then
                    custom_file="$2"
                    shift
                fi
                shift
                ;;
            -f|--file)
                if [[ -n "$2" ]]; then
                    html_file="$2"
                    shift 2
                else
                    echo "❌ Error: --file requires a filename"
                    exit 1
                fi
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                echo "❌ Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    # Use custom file if provided with --send
    if [[ -n "$custom_file" ]]; then
        html_file="$custom_file"
    fi
    
    echo "🚀 Inquiryon Lab Email Generator & Sender"
    echo "=========================================="
    echo
    
    # Validate recipients if sending email
    if [[ "$send_email_flag" == true ]]; then
        validate_recipients
    fi
    
    # Generate HTML if needed
    if [[ "$generate_only" == true ]]; then
        generate_html "$html_file"
        echo
        echo "📁 File saved to: $(pwd)/$html_file"
        echo "🔍 You can now review and edit the HTML file before sending."
        echo
        echo "💡 To send the email later, use:"
        echo "   $0 --send $html_file"
        
    elif [[ "$send_email_flag" == true ]]; then
        if [[ ! -f "$html_file" ]]; then
            echo "📝 HTML file not found. Generating new file..."
            generate_html "$html_file"
            echo
        fi
        
        send_email "$html_file"
        
    else
        # Default: generate and ask what to do next
        generate_html "$html_file"
        echo
        echo "📁 HTML file generated: $html_file"
        echo
        echo "What would you like to do next?"
        echo "1. Generate and review the HTML file"
        echo "2. Send email to recipients"
        echo "3. Exit"
        echo
        read -p "Enter your choice (1-3): " choice
        
        case $choice in
            1)
                if command -v open >/dev/null 2>&1; then
                    open "$html_file"
                elif command -v xdg-open >/dev/null 2>&1; then
                    xdg-open "$html_file"
                else
                    echo "📄 Please open $html_file in your browser to review."
                fi
                ;;
            2)
                send_email "$html_file"
                ;;
            3)
                echo "👋 Goodbye!"
                exit 0
                ;;
            *)
                echo "❌ Invalid choice. Exiting."
                exit 1
                ;;
        esac
    fi
}

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi